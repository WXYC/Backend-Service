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
 * stranded-claim TTL back to `'pending'`. The next CDC INSERT for the
 * same flowsheet id is rare (CDC fires on INSERT, not UPDATE), so the
 * actual re-enrichment path for swept rows is the nightly backfill cron
 * (`jobs/flowsheet-metadata-backfill`), which selects on
 * `metadata_attempt_at IS NULL`.
 *
 * SQL contract:
 *
 *   UPDATE wxyc_schema.flowsheet
 *      SET metadata_status = 'pending',
 *          enriching_since = NULL
 *    WHERE metadata_status = 'enriching'
 *      AND enriching_since < now() - interval '<TTL> seconds';
 *
 * Coverage:
 *   - `flowsheet_metadata_status_enriching_stale_idx` (schema.ts) is a
 *     partial B-tree on `enriching_since` WHERE `metadata_status='enriching'`,
 *     so the WHERE clause indexes both predicates in one scan.
 *   - The partial index has no `artist_name` / `entry_type` guard because
 *     `'enriching'` is only reachable from `'pending'`, which the writer
 *     already gates on `entry_type='track' AND artist_name IS NOT NULL`.
 *
 * TTL derivation:
 *
 *   The TTL MUST exceed the worker's LML budget (`ENRICHMENT_LML_BUDGET_MS`
 *   in `handler.ts`) plus enough slack for the finalize UPDATE to land.
 *   Otherwise the sweep races a still-in-flight claim: it reverts the row
 *   to `'pending'` while the worker is mid-LML-fetch, the worker's
 *   finalize then narrows on `metadata_status='enriching'` and matches 0
 *   rows (silently no-ops), and the LML token spend is wasted. Defined
 *   as `max(60s, LML_BUDGET + 30s)` to keep that invariant even if an
 *   operator bumps the LML budget. The 60s floor matches the original
 *   C6 design.
 *
 * Sentry projection:
 *
 *   Operational outcome surfaces as TWO spans per tick: the outer
 *   `enrichment.sweep.stranded` op span marks the work, and a child
 *   `enrichment.sweep.stranded.result` span carries the numeric
 *   `sweep.stranded_recovered_count` via the `attributes` field of
 *   `startSpan`. Per BS#1081 (and MEMORY's
 *   `feedback_sentry_attribute_typing_trap`), numeric values set via
 *   `setAttribute(name, number)` AFTER span creation are indexed as
 *   strings, breaking aggregation (avg/p50/p95/sum) on Sentry trace
 *   explorer dashboards. Passing them via the `attributes` option at
 *   creation indexes them as numbers. Same pattern as
 *   `jobs/artist-search-alias-consumer/job.ts:75-100`.
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import { envInt } from '@wxyc/lml-client';

const ENRICHMENT_LML_BUDGET_MS = envInt('ENRICHMENT_LML_BUDGET_MS', 29000);

/**
 * Seconds a row can sit in `'enriching'` before the sweep reverts it.
 * Floor of 60s preserves the original C6 contract; coupling to the LML
 * budget keeps the invariant `TTL > LML_BUDGET` even when the budget is
 * bumped via env. The 30s slack covers the post-LML finalize UPDATE.
 */
export const STRANDED_TTL_SECONDS = Math.max(60, Math.ceil(ENRICHMENT_LML_BUDGET_MS / 1000) + 30);

/**
 * Run one stranded-claim recovery pass. Returns the number of rows
 * reverted from `'enriching'` to `'pending'`. Throws on DB error so the
 * caller (the worker's tick loop) can decide whether to capture to
 * Sentry; this function does not swallow.
 */
export async function sweepStrandedClaims(): Promise<number> {
  return Sentry.startSpan(
    {
      name: 'enrichment.sweep.stranded',
      op: 'db.query',
      attributes: { 'sweep.ttl_seconds': STRANDED_TTL_SECONDS },
    },
    async () => {
      const reverted = await db
        .update(flowsheet)
        .set({
          metadata_status: 'pending',
          enriching_since: null,
        })
        .where(
          sql`${flowsheet.metadata_status} = 'enriching' AND ${flowsheet.enriching_since} < now() - make_interval(secs => ${STRANDED_TTL_SECONDS})`
        )
        .returning({ id: flowsheet.id });

      const count = reverted.length;
      // Surface the count as a child span whose numeric attribute is set
      // at creation time (BS#1081 typing-trap workaround). The child span
      // is a no-op other than as a carrier for the indexed attribute.
      Sentry.startSpan(
        {
          name: 'enrichment.sweep.stranded.result',
          attributes: { 'sweep.stranded_recovered_count': count },
        },
        () => {
          /* attribute set at creation; nothing else to do */
        }
      );
      return count;
    }
  );
}
