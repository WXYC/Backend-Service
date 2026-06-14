/**
 * Full enrichment handler for the CDC dispatcher (BS#892 / Epic C C2, PR-2).
 *
 * Composes the four pieces of the consumer:
 *   1. Filter the CDC event for an enrichment candidate (cdc-subscriber.ts).
 *   2. Atomically claim the row (claim.ts → flips `pending` → `enriching`).
 *   3. Look up via LML (`@wxyc/lml-client`, which carries the shared
 *      Semaphore(5) + TokenBucket(50/min) chokepoint).
 *   4. Finalize the row with the response (enrich.ts → flips `enriching`
 *      → terminal state, writes the metadata columns).
 *
 * Wrapped in a single Sentry transaction so trace events for one CDC tick
 * group together (cache_stats from the lookup span land as attributes on
 * the same transaction — see LML#213 + BS#646). Worker-side projection of
 * the outcome (`enrichment.outcome`) lets the Sentry trace explorer slice
 * matched/no-match/raced rates without per-row metric inventory.
 *
 * Errors handling:
 *   - Filter rejected → silent skip (not interesting).
 *   - Claim lost     → silent skip (sibling worker won — expected under N×N).
 *   - LML throws     → log + Sentry.captureException, row stays `enriching`.
 *                      The C6 stranded-claim sweep (#895) reverts it past
 *                      `enriching_since + 60s` so the next CDC tick retries.
 *   - DB throws      → log + Sentry.captureException, propagate. The CDC
 *                      listener will continue receiving events; only this
 *                      one is lost. The C6 sweep is the safety net.
 *
 * The handler never throws upstream. `cdc-listener.ts:54-58` already wraps
 * each callback in try/catch and would log `[cdc-listener] Callback error`
 * for an uncaught throw, but that log loses the row id and the LML/DB step
 * context. Catching here keeps the failure attributed to a real Sentry
 * event with the flowsheet_id + step tag instead of a noisy generic log.
 *
 * Sentry captureMessage volume control (BS#1311 — follow-up to BS#969 / PR
 * #1304). captureMessage fires only on `lml_degraded` outcomes that this
 * worker actually wrote — the LML#408 `_resolve_fallback_artwork` class
 * BS#969 was filed to surface. Three classes are deliberately silent:
 *   - `lml_no_match`: by-design Discogs miss, not a degradation. The
 *     `enrichment.outcome` span attribute (still set every tick) is the
 *     source of truth for dashboard-side rate aggregation.
 *   - `_raced` outcomes: a sibling worker / C6 sweep wrote the user-visible
 *     state. Firing here would cascade C6 recovery into a captureMessage
 *     flood whose events don't correspond to actual degradation.
 *   - The catch-arm LML throw: `captureException` already records the same
 *     event with a stack trace. The pre-1311 paired captureMessage was a
 *     redundant second quota slot per timeout.
 * The Sentry org quota is per-event ingestion, not per-issue grouping —
 * the original PR's stable-fingerprint argument did not bound burn. See
 * BS#1291 RCA for the quota exhaustion context that motivated this trim.
 */

import * as Sentry from '@sentry/node';
import { lookupMetadata, envInt } from '@wxyc/lml-client';
import type { CdcEvent } from '@wxyc/database';

import { claimRowForEnrichment } from './claim.js';
import { filterForEnrichment, type EnrichmentCandidate } from './cdc-subscriber.js';
import { EMPTY_OUTCOME_FINGERPRINT, classifyEmptyCause, isEmptyOutcome } from './empty-outcome.js';
// Suppression set for the post-finalize captureMessage block. Kept inline so
// the BS#1311 volume-control decision is co-located with the call site.
const SUPPRESSED_EMPTY_CAUSES: ReadonlySet<ReturnType<typeof classifyEmptyCause>> = new Set(['lml_no_match']);
import { finalizeRow, type FinalizeOutcome } from './enrich.js';

/**
 * Budget for the CDC consumer's lookup. Tracks the shared client's 30 s
 * fetch timeout with 1 s of slack so LML cuts off just before the
 * `AbortController` would — frees the row's `enriching` claim for C6 sweep
 * recovery (#895) sooner. See `LookupOptions.budgetMs` for mechanics.
 */
const ENRICHMENT_LML_BUDGET_MS = envInt('ENRICHMENT_LML_BUDGET_MS', 29000);

/**
 * Registry of in-flight `handleCandidate` invocations, used by the worker's
 * SIGTERM/SIGINT drain (BS#1108). Mirrors the backend's
 * `inFlightEnrichments` shape in
 * `apps/backend/services/metadata/enrichment.service.ts`.
 *
 * Without this registry the worker's shutdown path closes the PG pool while
 * LML lookups are still pending; the subsequent claim or finalize write
 * throws on a torn-down connection and the row stays in
 * `metadata_status='enriching'` until the C6 sweep (#895) reverts it past
 * `enriching_since + 60s` and triggers a second Discogs lookup whose answer
 * was already retrieved and discarded.
 */
const inFlightCandidates = new Set<Promise<unknown>>();

export function getInFlightCandidateCount(): number {
  return inFlightCandidates.size;
}

/**
 * Test-only: clear the registry without awaiting any of the in-flight
 * promises. Production code must never call this — drained candidates still
 * mutate the DB once their lookup resolves, so dropping them on the floor
 * mid-flight is exactly the bug this module avoids. The leading underscore
 * keeps that intent loud.
 */
export function _resetInFlightCandidatesForTest(): void {
  inFlightCandidates.clear();
}

/**
 * Wait up to `deadlineMs` for every in-flight candidate in the snapshot
 * taken at call time to settle, then return the *current registry size* —
 * which may include candidates added during the wait (a CDC event that
 * arrives between SIGTERM and `stopCdcListener()` completing can still
 * dispatch one). The returned count is therefore a drop *estimate*, not a
 * strict count of unsettled snapshot members; that's the right shape for a
 * `level: 'warning'` Sentry signal.
 *
 * Never throws. Returns 0 immediately when the registry is empty so a
 * healthy shutdown pays no setTimeout cost. Mirrors the backend's
 * `drainInFlightEnrichments` (BS#905).
 */
export async function drainInFlightCandidates(deadlineMs: number): Promise<number> {
  if (inFlightCandidates.size === 0) return 0;
  const snapshot = Array.from(inFlightCandidates);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(snapshot),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  return inFlightCandidates.size;
}

/**
 * Build a CDC event handler that runs the full enrichment chain.
 *
 * The returned function is the long-lived handler that
 * `onCdcEvent(handler)` registers; it is invoked once per CDC NOTIFY per
 * worker instance.
 */
export function makeEnrichmentHandler(): (event: CdcEvent) => void {
  return (event) => {
    const candidate = filterForEnrichment(event);
    if (!candidate) return;
    // Fire and forget. The CDC listener calls the handler synchronously; if
    // we awaited, slow LML lookups would back-pressure the listener and
    // cause it to drop events. The handler is internally bounded by the
    // shared LML Semaphore(5) so concurrency is capped at the chokepoint.
    //
    // BS#1108: register in the in-flight set so the SIGTERM drain can await
    // pending lookups before the DB pool closes. `handleCandidate` itself
    // never throws (its outer try/catch routes both LML errors and DB
    // errors through Sentry + console.error), so the .finally below always
    // fires and the registry can't slow-leak past a tick.
    const promise = handleCandidate(candidate);
    inFlightCandidates.add(promise);
    void promise.finally(() => {
      inFlightCandidates.delete(promise);
    });
  };
}

async function handleCandidate(candidate: EnrichmentCandidate): Promise<void> {
  await Sentry.startSpan(
    {
      name: 'enrichment.consumer.tick',
      op: 'queue.process',
      attributes: {
        'enrichment.flowsheet_id': candidate.id,
        'enrichment.has_album': candidate.album_title !== null,
        'enrichment.has_track': candidate.track_title !== null,
      },
    },
    async (span) => {
      try {
        const claim = await claimRowForEnrichment(candidate.id);
        if (!claim.claimed) {
          span.setAttribute('enrichment.outcome', 'claim_lost');
          return;
        }

        let outcome: FinalizeOutcome;
        let emptyCause: ReturnType<typeof classifyEmptyCause> | null = null;
        try {
          const response = await lookupMetadata(
            candidate.artist_name,
            candidate.album_title ?? undefined,
            candidate.track_title ?? undefined,
            { budgetMs: ENRICHMENT_LML_BUDGET_MS, caller: 'enrichment-worker' }
          );
          outcome = await finalizeRow(candidate, response);
          // G7 (BS#969): defer the captureMessage until after the
          // span.setAttribute below, but compute the classification while the
          // response is still in scope. `null` means the response was a real
          // user-visible match; non-null means we need to fire.
          if (isEmptyOutcome(response)) {
            emptyCause = classifyEmptyCause(response);
          }
        } catch (err) {
          // Row stays `enriching`. C6 stranded-claim sweep recovers it past
          // `enriching_since + 60s`. We do NOT revert to `pending` here —
          // doing so under a transient LML failure could re-deliver the
          // event to a sibling worker mid-failure, amplifying load against
          // an already-struggling LML.
          span.setAttribute('enrichment.outcome', 'lml_error');
          Sentry.captureException(err, {
            tags: { component: 'enrichment-worker', step: 'lml_lookup' },
            extra: { flowsheet_id: candidate.id },
          });
          // BS#1311: the paired captureMessage on the catch arm was dropped.
          // captureException above is the source-of-truth for the stack
          // trace; the extra captureMessage was a redundant second quota
          // slot per timeout (see file header for the full volume-control
          // rationale). The `enrichment.outcome=lml_error` span attribute
          // above keeps the throw class visible to dashboard aggregation.
          console.error('[enrichment-worker] lml error; row left in enriching state', {
            id: candidate.id,
            artist: candidate.artist_name,
            error: (err as Error).message,
          });
          return;
        }

        span.setAttribute('enrichment.outcome', outcome);

        // G7 (BS#969): emit the aggregated empty-outcome signal for rows
        // this worker finalized with no user-visible artwork URL — the
        // LML#408 `_resolve_fallback_artwork` class. Stable fingerprint so
        // cause-tagged aggregation persists across releases.
        //
        // BS#1311 volume control (see file header for the full rationale):
        //   - skip when outcome ends in `_raced` — a sibling worker / C6
        //     sweep wrote the user-visible state, not this worker
        //   - skip when cause is `lml_no_match` — by-design Discogs miss,
        //     not a degradation; the span attribute carries the signal
        // Net result: captureMessage fires only on `lml_degraded` outcomes
        // this worker wrote.
        if (emptyCause !== null && !outcome.endsWith('_raced') && !SUPPRESSED_EMPTY_CAUSES.has(emptyCause)) {
          Sentry.captureMessage('enrichment-empty-outcome', {
            level: 'warning',
            tags: {
              subsystem: 'metadata',
              cause: emptyCause,
              transaction: 'enrichment.consumer.tick',
              outcome,
            },
            extra: {
              flowsheet_id: candidate.id,
              artist: candidate.artist_name,
            },
            fingerprint: EMPTY_OUTCOME_FINGERPRINT,
          });
        }
      } catch (err) {
        // DB error during claim or finalize. Same defensive posture: capture
        // + log, row state is whatever PG ended up with. C6 sweep handles
        // any stranded `enriching` rows.
        span.setAttribute('enrichment.outcome', 'db_error');
        Sentry.captureException(err, {
          tags: { component: 'enrichment-worker', step: 'claim_or_finalize' },
          extra: { flowsheet_id: candidate.id },
        });
        console.error('[enrichment-worker] db error during enrichment', {
          id: candidate.id,
          error: (err as Error).message,
        });
      }
    }
  );
}
