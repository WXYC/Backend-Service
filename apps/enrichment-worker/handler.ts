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
 * The handler never throws upstream — the CDC listener is a single shared
 * subscriber across all CDC consumers in this process; a throw from this
 * handler could break other listeners. All failures are caught here.
 */

import * as Sentry from '@sentry/node';
import { lookupMetadata } from '@wxyc/lml-client';
import type { CdcEvent } from '@wxyc/database';

import { claimRowForEnrichment } from './claim.js';
import { filterForEnrichment, type EnrichmentCandidate } from './cdc-subscriber.js';
import { finalizeRow, type FinalizeOutcome } from './enrich.js';

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
        try {
          const response = await lookupMetadata(
            candidate.artist_name,
            candidate.album_title ?? undefined,
            candidate.track_title ?? undefined
          );
          outcome = await finalizeRow(candidate, response);
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
          console.error('[enrichment-worker] lml error; row left in enriching state', {
            id: candidate.id,
            artist: candidate.artist_name,
            error: (err as Error).message,
          });
          return;
        }

        span.setAttribute('enrichment.outcome', outcome);
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
