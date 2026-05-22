/**
 * Idempotent claim primitive for the enrichment consumer (BS#892 / Epic C C2).
 *
 * The consumer cardinality decision (see #892 body) is N×N with idempotent
 * claim: every BS instance runs a worker, the same CDC event is delivered to
 * every worker, and the first worker to win the atomic UPDATE does the LML
 * work. The losers see `RETURNING []` and skip cleanly.
 *
 * The 5-state enum on `flowsheet.metadata_status` (added in BS#891) is the
 * coordination mechanism:
 *
 *     pending  ──claim──▶  enriching  ──finalize──▶  enriched_match
 *                                                  / enriched_no_match
 *                                                  / failed_no_retry
 *
 * The claim WHERE narrows by `metadata_status='pending'`; only a row in
 * `pending` can be claimed. Once claimed, the row's `enriching_since` is
 * stamped so the C6 (#895) cron can identify stranded claims (process death
 * between claim and finalize leaves a row stuck in `enriching`).
 *
 * The finalize UPDATE (PR-2 of this child) will narrow by
 * `metadata_status='enriching'`, so a row finalized by one worker can't be
 * re-finalized by another. The whole pattern is race-free by construction.
 *
 * @see WXYC/Backend-Service#892
 * @see shared/database/src/migrations/0078_flowsheet-metadata-status.sql
 */

import { sql } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';

export type ClaimResult = { claimed: true; id: number } | { claimed: false };

/**
 * Attempt to claim a flowsheet row for enrichment.
 *
 * Atomically flips `metadata_status` from `'pending'` to `'enriching'` and
 * stamps `enriching_since = now()`. If the row is already in `'enriching'`
 * or any terminal state (`'enriched_match'`, `'enriched_no_match'`,
 * `'failed_no_retry'`), the UPDATE matches 0 rows and `{ claimed: false }`
 * is returned. Errors from the database propagate up.
 *
 * The id is taken as an argument rather than a row reference so this
 * primitive composes with both the CDC event dispatcher (which has the id
 * from the event payload) and the C6 recovery cron (which selects ids from
 * the partial index `flowsheet_metadata_status_pending_idx`).
 */
export async function claimRowForEnrichment(id: number): Promise<ClaimResult> {
  const updated = await db
    .update(flowsheet)
    .set({
      metadata_status: 'enriching',
      enriching_since: sql`now()`,
    })
    .where(sql`"id" = ${id} AND "metadata_status" = 'pending'`)
    .returning({ id: flowsheet.id });

  if (updated.length === 0) return { claimed: false };
  return { claimed: true, id: updated[0]!.id };
}
