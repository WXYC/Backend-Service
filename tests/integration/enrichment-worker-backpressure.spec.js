/**
 * Backpressure integration test for the enrichment worker (BS#892 / Epic C
 * C2). This is the "backpressure test at 1000 events / 1 second" acceptance
 * item from #892 — the last unchecked box on that child.
 *
 * What "backpressure" means for this consumer
 * -------------------------------------------
 * The CDC handler (`apps/enrichment-worker/handler.ts:139-169`) is
 * deliberately fire-and-forget: `makeEnrichmentHandler` returns synchronously
 * for every event so a slow LML lookup can never back-pressure the CDC
 * LISTEN socket and cause dropped NOTIFYs. Downstream concurrency is bounded
 * at the shared LML `Semaphore(5)` in `@wxyc/lml-client`, not at the handler.
 * So the one place where a 1000-event burst can actually corrupt state is the
 * atomic claim (`apps/enrichment-worker/claim.ts`): under the N×N fan-out
 * (every BS instance's worker receives every CDC event), a burst of 1000
 * inserts produces up to N×1000 concurrent claim CAS-UPDATEs racing across a
 * handful of distinct rows-per-id. The invariant that has to survive the
 * burst is *exactly-once*: every row claimed once, no row claimed twice, no
 * row left unclaimed.
 *
 * This spec exercises that invariant at the acceptance volume. The sibling
 * `enrichment-worker-claim.spec.js` covers the claim contract at low
 * cardinality (2-way and 10-way contention on a *single* row, terminal-state
 * safety, C6 stranded-claim recovery); this file adds the high-cardinality
 * burst dimension the acceptance item calls for.
 *
 * Pure SQL — does NOT import `claim.ts`. The integration runner is babel-jest
 * with no TS support (drizzle-orm + ts-jest incompatibility; see
 * `library-identity-backfill.spec.js` header). The `claimRow` helper is the
 * shared mirror of `claimRowForEnrichment` in `tests/utils/enrichment-claim.js`
 * (one canonical copy across the claim/sweep/backpressure specs); when
 * `claim.ts` is hand-edited that helper must follow.
 *
 * Why no hard throughput SLO: wall-clock through a 5-connection pool on a
 * shared CI runner is not a stable number, so the burst's elapsed time is
 * logged (not asserted). The real "the consumer keeps up / does not deadlock"
 * guard is the per-test timeout. The claim is a primary-key point lookup
 * (`WHERE id = $1 AND metadata_status = 'pending'`), so what a timeout catches
 * is a genuine deadlock or a pathological lock-contention collapse under the
 * burst — not an index regression: the partial `flowsheet_metadata_status_pending_idx`
 * serves the C6 bulk `WHERE metadata_status='pending'` scan, never this per-id
 * claim, so dropping it wouldn't slow the burst. Such a hang manifests as a
 * timeout, not a wrong answer.
 *
 * Coverage:
 *   1. Single-worker 1000-event burst: every row claimed exactly once; no row
 *      left pending. (Throughput/volume — one worker draining a full burst.)
 *   2. N×N fan-out burst: N workers each receive all 1000 events (N×1000
 *      claim attempts); exactly 1000 win, N×1000−1000 lose cleanly, every
 *      winning id is distinct, and no row is left pending. (The single-statement
 *      CAS is exactly-once by construction under row-level locking, so this
 *      pins that that invariant survives the live schema + index + pool at the
 *      N×N acceptance volume — it's the exactly-once claim that makes N×N
 *      delivery safe, verified at burst scale, not a proof that concurrency
 *      alone could break it.)
 *
 * @see WXYC/Backend-Service#892
 * @see tests/integration/enrichment-worker-claim.spec.js
 */

const { getTestDb } = require('../utils/db');
const { claimRow } = require('../utils/enrichment-claim');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** The acceptance volume: 1000 events in the burst. */
const BURST_SIZE = 1000;
/**
 * Simulated BS-instance count for the N×N fan-out test. 3 is enough to prove
 * the "every worker gets every event, exactly one wins" property without
 * ballooning the attempt count past what a 5-connection pool drains inside
 * the per-test timeout (3×1000 = 3000 CAS-UPDATEs).
 */
const N_WORKERS = 3;

/** Per-test timeout ceiling — the 30 s jest default is too tight for a
 * multi-thousand-statement burst through a 5-connection pool. Kept well under
 * any real deadlock so a hang still fails fast-ish. */
const BURST_TEST_TIMEOUT_MS = 60_000;

/** Distinctive prefix so cleanup (and any post-mortem) is unambiguous. */
const ARTIST_PREFIX = 'enrichment-backpressure-artist-';

/**
 * Bulk-insert `n` fresh pending track rows in a single server-side
 * `INSERT … SELECT … FROM generate_series` (fast; no 1000-way client
 * marshaling). Returns the new ids. Mirrors the column set the sibling
 * claim spec's `insertPendingRow` uses:
 *   - `metadata_status='pending'` is the claimable state (BS#891).
 *   - `show_id` is intentionally omitted (flowsheet permits NULL show_id).
 *   - `play_order` (NOT NULL) draws from an 800000+ band unique to this spec,
 *     keeping it clear of the sibling specs' sentinels (claim `99999`, sweep
 *     `99998`) under the shared `--runInBand` schema. Both burst tests draw
 *     from the same band (their rows coexist until the shared `afterAll`),
 *     which is safe today because `play_order` carries no uniqueness constraint
 *     and `show_id` is NULL — so even a future `(show_id, play_order)` unique
 *     wouldn't fire on these rows.
 */
async function bulkInsertPendingRows(sql, n) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (play_order, entry_type, artist_name, album_title, track_title, metadata_status, request_flag, segue)
    SELECT
      800000 + g,
      'track',
      ${ARTIST_PREFIX} || g,
      'Test Album',
      'Test Track',
      'pending',
      false,
      false
    FROM generate_series(1, ${n}) AS g
    RETURNING id
  `;
  return rows.map((r) => r.id);
}

/**
 * Assert the terminal DB state of a fully-drained burst: none of `ids` left
 * `'pending'`, and every one of them moved to `'enriching'` (the enriching
 * count equals `ids.length`). Both burst tests assert this same post-condition;
 * keeping it in one place mirrors the single-`claimRow`-mirror rationale in
 * `tests/utils/enrichment-claim.js`. Local to this spec by design — it encodes
 * the backpressure post-condition, not a cross-spec contract, so it stays
 * beside the tests that use it.
 */
async function expectAllEnriched(sql, ids) {
  const pendingLeft = await sql`
    SELECT count(*)::int AS n
      FROM ${sql(SCHEMA)}.flowsheet
     WHERE id = ANY(${ids})
       AND metadata_status = 'pending'
  `;
  expect(pendingLeft[0].n).toBe(0);

  const enrichingCount = await sql`
    SELECT count(*)::int AS n
      FROM ${sql(SCHEMA)}.flowsheet
     WHERE id = ANY(${ids})
       AND metadata_status = 'enriching'
  `;
  expect(enrichingCount[0].n).toBe(ids.length);
}

describe('enrichment-worker backpressure — 1000-event burst (real PG)', () => {
  let sql;
  /** ids inserted by tests; deleted in afterAll regardless of pass/fail. */
  const insertedIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    // Delete by id (exact, indexed) for the rows we tracked, plus a
    // belt-and-suspenders prefix sweep in case a test threw mid-insert before
    // its ids were recorded. The prefix is unique to this spec.
    if (insertedIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${insertedIds})`;
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE artist_name LIKE ${ARTIST_PREFIX + '%'}`;
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  test(
    'single-worker burst: 1000 events → every row claimed exactly once, none left pending',
    async () => {
      const ids = await bulkInsertPendingRows(sql, BURST_SIZE);
      insertedIds.push(...ids);
      expect(ids).toHaveLength(BURST_SIZE);

      // One worker receives all 1000 CDC events at once and fires a claim for
      // each. Promise.all queues them through the 5-connection pool.
      const start = Date.now();
      const results = await Promise.all(ids.map((id) => claimRow(sql, id)));
      const elapsedMs = Date.now() - start;

      const wins = results.filter((r) => r.claimed);
      const losses = results.filter((r) => !r.claimed);

      // Every distinct pending row is claimable exactly once by a single
      // worker: 1000 events → 1000 wins, 0 losses.
      expect(wins).toHaveLength(BURST_SIZE);
      expect(losses).toHaveLength(0);

      // The winning ids are exactly the inserted set — nothing dropped.
      const wonIds = wins.map((r) => r.id).sort((a, b) => a - b);
      expect(wonIds).toEqual([...ids].sort((a, b) => a - b));

      // DB state: all rows moved pending → enriching; none stranded pending.
      await expectAllEnriched(sql, ids);

      // Throughput is logged, not asserted (see file header).
      console.log(
        `[backpressure] single-worker: ${BURST_SIZE} claims in ${elapsedMs}ms ` +
          `(${Math.round((BURST_SIZE / elapsedMs) * 1000)} rows/sec)`
      );
    },
    BURST_TEST_TIMEOUT_MS
  );

  test(
    'N×N fan-out burst: 3 workers × 1000 events → exactly 1000 wins, no double-claim, none left pending',
    async () => {
      const ids = await bulkInsertPendingRows(sql, BURST_SIZE);
      insertedIds.push(...ids);
      expect(ids).toHaveLength(BURST_SIZE);

      // Simulate the N×N fan-out: every one of N_WORKERS worker instances
      // receives every CDC event, so each id is raced by N_WORKERS concurrent
      // claims. Interleave (worker-major would let worker 0 finish the whole
      // burst before worker 1 starts, defeating the contention). Building one
      // flat array of N_WORKERS×BURST_SIZE claims and firing them together is
      // the closest single-process approximation of the real burst.
      const attempts = [];
      for (let i = 0; i < BURST_SIZE; i++) {
        for (let w = 0; w < N_WORKERS; w++) {
          attempts.push(claimRow(sql, ids[i]));
        }
      }
      expect(attempts).toHaveLength(N_WORKERS * BURST_SIZE);

      const start = Date.now();
      const results = await Promise.all(attempts);
      const elapsedMs = Date.now() - start;

      const wins = results.filter((r) => r.claimed);
      const losses = results.filter((r) => !r.claimed);

      // Exactly one claim per row wins; the other (N_WORKERS−1) per row lose
      // cleanly — the exactly-once invariant the single-statement CAS gives by
      // construction, pinned here against the live table at burst volume.
      expect(wins).toHaveLength(BURST_SIZE);
      expect(losses).toHaveLength((N_WORKERS - 1) * BURST_SIZE);

      // No row won twice: the winning ids are distinct and cover the whole
      // inserted set. (A double-claim would show up as a duplicate id here
      // and as fewer than BURST_SIZE distinct winners.)
      const wonIds = wins.map((r) => r.id);
      const distinctWonIds = new Set(wonIds);
      expect(distinctWonIds.size).toBe(BURST_SIZE);
      expect([...distinctWonIds].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));

      // DB state: no row stranded pending; every row ended enriching.
      await expectAllEnriched(sql, ids);

      console.log(
        `[backpressure] N×N fan-out: ${N_WORKERS * BURST_SIZE} claim attempts ` +
          `(${N_WORKERS} workers × ${BURST_SIZE} events) in ${elapsedMs}ms ` +
          `(${Math.round((BURST_SIZE / elapsedMs) * 1000)} rows/sec drained)`
      );
    },
    BURST_TEST_TIMEOUT_MS
  );
});
