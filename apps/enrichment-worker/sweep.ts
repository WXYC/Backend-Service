/**
 * Stranded-claim recovery sweep for the enrichment consumer
 * (BS#1225 / Epic C C6 split).
 *
 * The C2 worker (BS#892) flips `metadata_status` from `'pending'` to
 * `'enriching'` and stamps `enriching_since = now()` before calling LML.
 * If the LML call throws or the worker process dies (SIGTERM, crash, OOM)
 * between the claim and the finalize, the row sits in `'enriching'`
 * indefinitely — invisible to both the CDC consumer (which only filters
 * `'pending'`) and the backfill cron. This sweep is the safety net: it
 * flips any `'enriching'` row whose `enriching_since` is older than the
 * 60-second TTL back to `'pending'`, so the next CDC tick (or the
 * backfill drain) re-enqueues it.
 *
 * SQL contract:
 *
 *   UPDATE wxyc_schema.flowsheet
 *      SET metadata_status = 'pending',
 *          enriching_since = NULL
 *    WHERE metadata_status = 'enriching'
 *      AND enriching_since < now() - interval '60 seconds';
 *
 * Coverage:
 *   - `flowsheet_metadata_status_enriching_stale_idx` (schema.ts) is a
 *     partial B-tree on `enriching_since` WHERE `metadata_status='enriching'`,
 *     so the WHERE clause indexes both predicates in one scan.
 *   - The partial index has no `artist_name` / `entry_type` guard because
 *     `'enriching'` is only reachable from `'pending'`, which the writer
 *     already gates on `entry_type='track' AND artist_name IS NOT NULL`.
 *   - The 60s TTL is the floor; this function is intended to run at a
 *     per-minute cadence by the worker. See `worker.ts` for the wiring.
 *
 * Sentry projection: each sweep tick is wrapped in a span carrying
 * `sweep.stranded_recovered_count` so the trace explorer can answer "are
 * we leaking rows?" without per-row metric inventory. The pattern mirrors
 * the consumer-tick instrumentation in `handler.ts` (project-onto-span
 * at the chokepoint per LML#213 + BS#646).
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';

/**
 * Run one stranded-claim recovery pass. Returns the number of rows
 * reverted from `'enriching'` to `'pending'`. Throws on DB error so
 * the caller (the worker's tick loop) can decide whether to capture
 * to Sentry; this function does not swallow.
 */
export async function sweepStrandedClaims(): Promise<number> {
  return Sentry.startSpan(
    {
      name: 'enrichment.sweep.stranded',
      op: 'db.query',
    },
    async (span) => {
      const reverted = await db
        .update(flowsheet)
        .set({
          metadata_status: 'pending',
          enriching_since: null,
        })
        .where(
          sql`${flowsheet.metadata_status} = 'enriching' AND ${flowsheet.enriching_since} < now() - interval '60 seconds'`
        )
        .returning({ id: flowsheet.id });

      const count = reverted.length;
      span.setAttribute('sweep.stranded_recovered_count', count);
      return count;
    }
  );
}
