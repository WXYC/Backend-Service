/**
 * Integration test for the enrichment worker's idempotent-claim contract
 * (BS#892 / Epic C C2, PR-3).
 *
 * The worker's N×N cardinality (every BS instance runs a worker; every
 * CDC event reaches every worker) is only safe if the atomic
 *   UPDATE flowsheet
 *     SET metadata_status='enriching', enriching_since=now()
 *     WHERE id=$1 AND metadata_status='pending'
 *     RETURNING id
 * behaves as documented: when N siblings race the same id, exactly one
 * returns a row and the rest return empty arrays. The unit tests
 * (`tests/unit/apps/enrichment-worker/claim.test.ts`) cover the Drizzle
 * builder shape against a mock DB; this spec validates the actual
 * PostgreSQL row-level locking semantics against the live `flowsheet`
 * table + BS#891's 5-state enum + the partial index from
 * `flowsheet_metadata_status_pending_idx`.
 *
 * Pure SQL — does NOT import `apps/enrichment-worker/claim.ts`. The
 * integration runner is babel-jest with no TS support (see
 * `library-identity-backfill.spec.js` header for the drizzle-orm
 * + ts-jest incompatibility). The unit-vs-integration division here:
 *   - Unit: source-code shape (typed builders, WHERE narrowing, race
 *     detector returning behavior).
 *   - Integration (this file): SQL contract under real concurrency.
 *
 * Coverage:
 *   1. Two concurrent claim CAS-UPDATEs on a pending row: exactly one wins.
 *   2. N=10 concurrent claims on the same row: exactly one wins.
 *   3. Once `enriching`, no further claim can win (terminal-state contract).
 *   4. Once in a terminal state (`enriched_match`, `enriched_no_match`,
 *      `failed_no_retry`), no further claim can win.
 *   5. C6-style stranded-claim recovery: claim → backdate `enriching_since`
 *      past the 60s TTL → recovery sweep reverts to `pending` → claim
 *      succeeds again. The C6 sweep itself ships in BS#895, but the SQL
 *      that sweep will run is exercised here so a schema change that
 *      breaks the sweep fails CI now, not when C6 lands.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Issue the worker's CAS-UPDATE directly. Mirrors `claimRowForEnrichment`
 * in `apps/enrichment-worker/claim.ts` — when that file is hand-edited the
 * SQL here must follow.
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

/**
 * Insert a fresh pending track row. Returns the new id. Uses an obviously
 * synthetic artist_name so cleanup is unambiguous.
 */
async function insertPendingRow(sql, suffix) {
  // `play_order` is NOT NULL on the schema; use a high constant so we don't
  // collide with rows from sibling specs. metadata_status defaults to
  // 'pending' (BS#891) but pass it explicitly for documentation.
  // `show_id` is intentionally omitted — flowsheet permits NULL show_id for
  // entries that pre-date a show / are orphaned from one (canonical
  // upstream-permitted shape per `schema.ts:flowsheet`). If that ever
  // gains NOT NULL, this spec breaks loudly.
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (play_order, entry_type, artist_name, album_title, track_title, metadata_status, request_flag, segue)
    VALUES
      (99999, 'track', ${'enrichment-claim-test-artist-' + suffix}, 'Test Album', 'Test Track', 'pending', false, false)
    RETURNING id
  `;
  return rows[0].id;
}

describe('enrichment-worker claim primitive (real PG)', () => {
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

  test('two concurrent claims on the same pending row: exactly one wins', async () => {
    const id = await insertPendingRow(sql, 'two-concurrent');
    insertedIds.push(id);

    // Promise.all kicks both off in the same microtask; the underlying
    // postgres-js driver opens two connections (pool.max=5 in db.js), so
    // these execute against PG concurrently. Row-level locking on the
    // UPDATE serializes them: the loser's WHERE no longer matches
    // `metadata_status='pending'` and RETURNING yields 0 rows.
    const [a, b] = await Promise.all([claimRow(sql, id), claimRow(sql, id)]);

    const wins = [a, b].filter((r) => r.claimed);
    expect(wins).toHaveLength(1);
    expect(wins[0].id).toBe(id);

    const losses = [a, b].filter((r) => !r.claimed);
    expect(losses).toHaveLength(1);

    // Post-claim row state: enriching, with enriching_since set.
    const after = await sql`
      SELECT metadata_status, enriching_since
        FROM ${sql(SCHEMA)}.flowsheet
       WHERE id = ${id}
    `;
    expect(after[0].metadata_status).toBe('enriching');
    expect(after[0].enriching_since).not.toBeNull();
  });

  test('N=10 attempts (~5 in parallel via the pool + rest serialized): exactly one wins', async () => {
    // The shared pool in tests/utils/db.js has `max: 5`, so only 5 of the
    // 10 promises actually race against PG simultaneously; the remaining
    // 5 execute as the first batch releases connections. The contract
    // (exactly one wins) holds either way — the row-level lock on the
    // UPDATE serializes claims regardless of how parallel the wire
    // contention is. The test name makes the pool ceiling explicit so a
    // future reader doesn't misread it as 10-way parallelism.
    const id = await insertPendingRow(sql, 'ten-concurrent');
    insertedIds.push(id);

    const results = await Promise.all(Array.from({ length: 10 }, () => claimRow(sql, id)));

    const wins = results.filter((r) => r.claimed);
    expect(wins).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(9);
  });

  test('once enriching, no further claim can win', async () => {
    const id = await insertPendingRow(sql, 'already-enriching');
    insertedIds.push(id);

    const first = await claimRow(sql, id);
    expect(first.claimed).toBe(true);

    const second = await claimRow(sql, id);
    expect(second.claimed).toBe(false);
  });

  test.each([['enriched_match'], ['enriched_no_match'], ['failed_no_retry']])(
    'once in terminal state %s, no further claim can win',
    async (terminalStatus) => {
      const id = await insertPendingRow(sql, `terminal-${terminalStatus}`);
      insertedIds.push(id);

      // Claim then finalize.
      await claimRow(sql, id);
      await sql`
        UPDATE ${sql(SCHEMA)}.flowsheet
           SET metadata_status = ${terminalStatus}
         WHERE id = ${id}
      `;

      const attempt = await claimRow(sql, id);
      expect(attempt.claimed).toBe(false);
    }
  );

  test('C6-style stranded-claim recovery: backdate enriching_since → sweep → re-claim succeeds', async () => {
    const id = await insertPendingRow(sql, 'stranded');
    insertedIds.push(id);

    // 1. Claim, then simulate process death: the row sits at 'enriching'
    //    with an enriching_since past the recovery TTL.
    await claimRow(sql, id);
    await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet
         SET enriching_since = now() - interval '2 minutes'
       WHERE id = ${id}
    `;

    // 2. C6 recovery sweep SQL — shipped as `sweepStrandedClaims` in
    //    `apps/enrichment-worker/sweep.ts` (BS#1225). End-to-end coverage
    //    of the real sweep function against multi-row batches and
    //    terminal-state safety lives in `enrichment-worker-sweep.spec.js`;
    //    this assertion remains as a sibling-level pin so a schema change
    //    that breaks the sweep also fails this spec.
    const reverted = await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet
         SET metadata_status = 'pending',
             enriching_since = NULL
       WHERE metadata_status = 'enriching'
         AND enriching_since < now() - interval '60 seconds'
         AND id = ${id}
      RETURNING id
    `;
    expect(reverted).toHaveLength(1);

    // 3. Row is claimable again.
    const reclaim = await claimRow(sql, id);
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.id).toBe(id);
  });

  test('stranded-claim recovery does NOT touch rows whose enriching_since is recent', async () => {
    const id = await insertPendingRow(sql, 'stranded-recent');
    insertedIds.push(id);

    await claimRow(sql, id);
    // enriching_since defaults to now() from the claim; recovery should
    // leave it alone (60s TTL not yet hit).

    const reverted = await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet
         SET metadata_status = 'pending',
             enriching_since = NULL
       WHERE metadata_status = 'enriching'
         AND enriching_since < now() - interval '60 seconds'
         AND id = ${id}
      RETURNING id
    `;
    expect(reverted).toHaveLength(0);

    const after = await sql`
      SELECT metadata_status FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${id}
    `;
    expect(after[0].metadata_status).toBe('enriching');
  });
});
