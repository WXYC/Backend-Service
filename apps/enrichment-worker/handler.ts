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
 */

import * as Sentry from '@sentry/node';
import { lookupMetadata, envInt } from '@wxyc/lml-client';
import type { CdcEvent } from '@wxyc/database';

import { claimRowForEnrichment } from './claim.js';
import { filterForEnrichment, type EnrichmentCandidate } from './cdc-subscriber.js';
import { EMPTY_OUTCOME_FINGERPRINT, classifyEmptyCause, isEmptyOutcome } from './empty-outcome.js';
import { finalizeRow, type FinalizeOutcome } from './enrich.js';

/**
 * Budget for the CDC consumer's lookup. Tracks the shared client's 30 s
 * fetch timeout with 1 s of slack so LML cuts off just before the
 * `AbortController` would — frees the row's `enriching` claim for C6 sweep
 * recovery (#895) sooner. See `LookupOptions.budgetMs` for mechanics.
 */
const ENRICHMENT_LML_BUDGET_MS = envInt('ENRICHMENT_LML_BUDGET_MS', 29000);

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
    void handleCandidate(candidate);
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
          // G7 (BS#969): also fold the throw into the aggregated
          // enrichment-empty-outcome issue with cause=lml_timeout so the
          // post-fix baseline + alert threshold see the throws alongside the
          // degraded-success class. Sibling captureException above stays as
          // the source-of-truth for the stack trace.
          Sentry.captureMessage('enrichment-empty-outcome', {
            level: 'warning',
            tags: {
              subsystem: 'metadata',
              cause: 'lml_timeout',
              transaction: 'enrichment.consumer.tick',
            },
            extra: {
              flowsheet_id: candidate.id,
              error_message: (err as Error).message,
            },
            fingerprint: EMPTY_OUTCOME_FINGERPRINT,
          });
          console.error('[enrichment-worker] lml error; row left in enriching state', {
            id: candidate.id,
            artist: candidate.artist_name,
            error: (err as Error).message,
          });
          return;
        }

        span.setAttribute('enrichment.outcome', outcome);

        // G7 (BS#969): emit the aggregated empty-outcome signal for rows that
        // finalized with no user-visible artwork URL (the LML#408
        // _resolve_fallback_artwork class, plus explicit no-match verdicts).
        // Stable fingerprint so cause-tagged aggregation persists across
        // releases.
        if (emptyCause !== null) {
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
