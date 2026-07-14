/**
 * Shared test helper for the enrichment worker's idempotent-claim contract.
 *
 * `claimRow` is the ONE canonical mirror of `claimRowForEnrichment` in
 * `apps/enrichment-worker/claim.ts`. The three enrichment integration specs
 * (claim, sweep, backpressure) each need to issue the worker's exact
 * CAS-UPDATE; before this module they carried three byte-identical copies of
 * it, so a hand-edit to `claim.ts` had to be chased through three files. This
 * centralizes the lockstep pin: when `claim.ts` is hand-edited, the SQL here
 * must follow, and all three specs pick up the change from one place.
 *
 * Pure SQL — this does NOT import `claim.ts`. The integration runner is
 * babel-jest with no TS support (drizzle-orm + ts-jest incompatibility; see
 * `enrichment-worker-claim.spec.js` header). That's precisely why the SQL is
 * duplicated from the TS source rather than imported — and precisely why it
 * belongs in exactly one place.
 *
 * Only `claimRow` lives here. The specs' `insertPendingRow` /
 * `bulkInsertPendingRows` helpers are deliberately NOT shared: they use
 * genuinely different insert strategies (single-row VALUES with a
 * human-readable per-test artist suffix vs. bulk `generate_series`) and
 * distinct `play_order` sentinels (`99999` / `99998` / `800000+g`) chosen so
 * sibling specs can't collide under the shared `--runInBand` schema. Folding
 * those into one parametric helper would be speculative generality that
 * degrades the readable-suffix cleanup for no real dedup win.
 */

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Issue the worker's claim CAS-UPDATE directly against `flowsheet`. Mirrors
 * `claimRowForEnrichment` in `apps/enrichment-worker/claim.ts`: flip a
 * `pending` row to `enriching`, stamp `enriching_since = now()`, and use the
 * `RETURNING` length to report whether this caller won the race.
 *
 * @param {import('postgres').Sql} sql - the shared test pool from `getTestDb()`.
 * @param {number} id - the `flowsheet.id` to claim.
 * @returns {Promise<{claimed: true, id: number} | {claimed: false}>} `claimed`
 *   is true (with the won id) iff this caller's UPDATE matched a still-`pending`
 *   row; false when a sibling already claimed it (empty `RETURNING`).
 */
async function claimRow(sql, id) {
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.flowsheet
       SET metadata_status = 'enriching',
           enriching_since = now()
     WHERE id = ${id}
       AND metadata_status = 'pending'
    RETURNING id
  `;
  return rows.length > 0 ? { claimed: true, id: rows[0].id } : { claimed: false };
}

module.exports = { claimRow };
