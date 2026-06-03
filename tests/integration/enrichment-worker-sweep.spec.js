/**
 * Integration test for the enrichment worker's stranded-claim sweep
 * (BS#1225 / Epic C C6 split).
 *
 * The C2 worker (BS#892) flips `metadata_status` from `'pending'` to
 * `'enriching'` before calling LML; if the LML call throws or the worker
 * process dies before the finalize, the row sits in `'enriching'` forever.
 * `apps/enrichment-worker/sweep.ts` is the safety net: every 60s it flips
 * any `'enriching'` row past the `enriching_since + 60s` TTL back to
 * `'pending'`. The unit test
 * (`tests/unit/apps/enrichment-worker/sweep.test.ts`) covers the Drizzle
 * builder shape against the mock DB; this spec validates the actual SQL
 * contract against the live `flowsheet` table + the partial index
 * `flowsheet_metadata_status_enriching_stale_idx`.
 *
 * Pure SQL — does NOT import `apps/enrichment-worker/sweep.ts`. The
 * integration runner is babel-jest with no TS support (see
 * `enrichment-worker-claim.spec.js` header for the drizzle-orm + ts-jest
 * incompatibility). The SQL below MUST stay in lockstep with the
 * implementation; that's exactly what's being pinned.
 *
 * Coverage:
 *   1. Single stranded row: claim → backdate `enriching_since` past the
 *      TTL → sweep → row is `'pending'` again, `enriching_since IS NULL`,
 *      re-claim succeeds.
 *   2. Batch recovery: N=5 stranded rows are recovered in one sweep tick.
 *   3. Recent-claim safety: a row whose `enriching_since` is within the
 *      60s TTL is NOT touched.
 *   4. Terminal-state safety: rows in `'enriched_match'`,
 *      `'enriched_no_match'`, `'failed_no_retry'` are NOT touched.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Issue the worker's sweep SQL directly. Mirrors `sweepStrandedClaims` in
 * `apps/enrichment-worker/sweep.ts` — when that file is hand-edited the
 * SQL here must follow. Returns the count of rows reverted.
 *
 * Pins the SQL contract at the production-default TTL (60s, which
 * STRANDED_TTL_SECONDS resolves to when `ENRICHMENT_LML_BUDGET_MS` is at
 * its 29s default). If a future change raises the LML budget high enough
 * to push the derived TTL above 60s, the test backdates below are
 * deliberately well above any reasonable TTL so the recovery path still
 * fires; only the "exact cutoff" boundary would drift, which is
 * intentional — the test pins behavior at the default deployment.
 *
 * Scoped to `id = ANY(scopeIds)` so sibling integration specs running
 * against the same shared schema under `--runInBand` can't cross-affect
 * one another's rows. Production `sweepStrandedClaims` is unscoped (it
 * sweeps the whole table) — that's correct behavior there; the scoping
 * here exists purely for test isolation.
 */
async function runSweep(sql, scopeIds) {
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.flowsheet
       SET metadata_status = 'pending',
           enriching_since = NULL
     WHERE metadata_status = 'enriching'
       AND enriching_since < now() - interval '60 seconds'
       AND id = ANY(${scopeIds})
    RETURNING id
  `;
  return rows.length;
}

/**
 * Insert a fresh pending track row. Same shape as the claim spec's helper
 * (NOT NULL `play_order`, omitted `show_id` per upstream-permitted shape).
 */
async function insertPendingRow(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (play_order, entry_type, artist_name, album_title, track_title, metadata_status, request_flag, segue)
    VALUES
      (99998, 'track', ${'enrichment-sweep-test-artist-' + suffix}, 'Test Album', 'Test Track', 'pending', false, false)
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Mirror of the worker's claim SQL — flip the row to `'enriching'` and
 * stamp `enriching_since = now()`. Returns whether the claim won.
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
  return rows.length > 0;
}

/**
 * Backdate a row's `enriching_since` past the 60s TTL so the next sweep
 * picks it up. Mirrors the conditions a process death between claim and
 * finalize would produce, ~minutes after the fact.
 */
async function backdateEnrichingSince(sql, id, seconds) {
  await sql`
    UPDATE ${sql(SCHEMA)}.flowsheet
       SET enriching_since = now() - make_interval(secs => ${seconds})
     WHERE id = ${id}
  `;
}

describe('enrichment-worker stranded-claim sweep (real PG)', () => {
  let sql;
  /** ids inserted by tests; deleted in afterAll regardless of pass/fail. */
  const insertedIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${insertedIds})`;
    }
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  test('single stranded claim: sweep reverts to pending and clears enriching_since', async () => {
    const id = await insertPendingRow(sql, 'single-stranded');
    insertedIds.push(id);

    expect(await claimRow(sql, id)).toBe(true);
    // Backdate well above any reasonable derived TTL so the test pinning
    // remains correct if STRANDED_TTL_SECONDS grows beyond 60s.
    await backdateEnrichingSince(sql, id, 600);

    await runSweep(sql, [id]);

    const [row] = await sql`
      SELECT metadata_status, enriching_since
        FROM ${sql(SCHEMA)}.flowsheet
       WHERE id = ${id}
    `;
    expect(row.metadata_status).toBe('pending');
    expect(row.enriching_since).toBeNull();

    // Row is claimable again — the contract the C2 worker depends on.
    expect(await claimRow(sql, id)).toBe(true);
  });

  test('batch recovery: 5 stranded rows are reverted in a single sweep tick', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await insertPendingRow(sql, `batch-${i}`);
      ids.push(id);
      insertedIds.push(id);
      await claimRow(sql, id);
      // Backdate well above any reasonable derived TTL — see runSweep
      // header for the lockstep rationale.
      await backdateEnrichingSince(sql, id, 600);
    }

    await runSweep(sql, ids);

    const rows = await sql`
      SELECT id, metadata_status
        FROM ${sql(SCHEMA)}.flowsheet
       WHERE id = ANY(${ids})
       ORDER BY id
    `;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.metadata_status).toBe('pending');
    }
  });

  test('recent claim within the 60s TTL is NOT touched by the sweep', async () => {
    const id = await insertPendingRow(sql, 'recent-claim');
    insertedIds.push(id);

    expect(await claimRow(sql, id)).toBe(true);
    // enriching_since defaulted to now() — well inside the 60s TTL.
    await runSweep(sql, [id]);

    const [row] = await sql`
      SELECT metadata_status, enriching_since
        FROM ${sql(SCHEMA)}.flowsheet
       WHERE id = ${id}
    `;
    expect(row.metadata_status).toBe('enriching');
    expect(row.enriching_since).not.toBeNull();
  });

  test('terminal-state rows are NOT touched by the sweep', async () => {
    // For each terminal state, set up a row that would superficially look
    // sweep-eligible if the WHERE narrowed only by `enriching_since`. The
    // sweep MUST narrow by `metadata_status='enriching'` too — if it ever
    // loosens, this test fails by reverting completed rows to `pending`
    // and re-enqueueing already-done work.
    const terminalStates = ['enriched_match', 'enriched_no_match', 'failed_no_retry'];
    const ids = [];
    for (const state of terminalStates) {
      const id = await insertPendingRow(sql, `terminal-${state}`);
      ids.push(id);
      insertedIds.push(id);
      await sql`
        UPDATE ${sql(SCHEMA)}.flowsheet
           SET metadata_status = ${state},
               enriching_since = now() - interval '5 minutes'
         WHERE id = ${id}
      `;
    }

    await runSweep(sql, ids);

    const rows = await sql`
      SELECT id, metadata_status
        FROM ${sql(SCHEMA)}.flowsheet
       WHERE id = ANY(${ids})
       ORDER BY id
    `;
    expect(rows.map((r) => r.metadata_status).sort()).toEqual([...terminalStates].sort());
  });
});
