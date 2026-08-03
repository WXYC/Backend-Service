/**
 * BS#1960 — deep OFFSET pagination on GET /flowsheet.
 *
 * Pre-fix, `getEntriesByPage`'s OFFSET/LIMIT sat on the fully-joined query
 * (3 LEFT JOINs against rotation/library/album_metadata), so Postgres had to
 * compute the joined row for every one of the `offset` discarded rows before
 * it could discard them. Latency grew ~11ms per discarded row and the
 * endpoint 500'd once `offset` passed roughly 450-500, hitting this RDS
 * instance's 5s statement_timeout. The fix (deferred-join / late-row-lookup)
 * resolves the page of `flowsheet.id`s first, against the bare PK index, and
 * joins only the already-bounded page.
 *
 * This spec bulk-inserts a large, uniquely-tagged batch of track rows so a
 * deep page (page=50, limit=100 — offset 5,000, the acceptance floor from
 * the issue) has real, predictable content to assert on regardless of
 * whatever else is in the shared dev/CI schema. It is a correctness/
 * regression check (200 not 500, right shape, right rows) — it does not by
 * itself prove the latency fix; that needs an EXPLAIN ANALYZE against
 * prod-shaped data (reviewer/deploy-time step).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const MARKER = 'BS1960 Deep Page Probe';
// Comfortably clears the page=50 * limit=100 = 5,000 offset acceptance
// floor, with headroom so the assertions below land entirely inside this
// spec's own batch rather than spilling into whatever else is seeded.
const BATCH_SIZE = 5200;

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('GET /flowsheet deep OFFSET pagination (BS#1960)', () => {
  let sql;
  let insertedIds = [];

  beforeAll(async () => {
    sql = makeSql();

    // Single bulk INSERT ... SELECT so the batch lands as one contiguous,
    // monotonically increasing id block at the tail of the table — no other
    // writer touches `flowsheet` while this statement runs (--runInBand).
    // n=1 is the OLDEST row in the batch (lowest id), n=BATCH_SIZE the
    // NEWEST (highest id) — the batch is therefore the most-recent
    // BATCH_SIZE rows in the whole table once this insert commits.
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, artist_name, track_title, play_order)
       SELECT 'track', $1, $1 || ' #' || n, n
       FROM generate_series(1, $2) AS n
       RETURNING id`,
      [MARKER, BATCH_SIZE]
    );
    insertedIds = rows.map((r) => r.id);
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedIds]);
    }
    if (sql) await sql.end();
  });

  test('page=50&limit=100 (offset 5,000) returns 200 with correctly-shaped, correctly-ordered V2 entries', async () => {
    const res = await request.get('/flowsheet').query({ page: 50, limit: 100 }).send().expect(200);

    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries).toHaveLength(100);
    expect(res.body.page).toBe(50);
    expect(res.body.limit).toBe(100);

    // Deterministic content check. Ordered by flowsheet.id DESC (most recent
    // first), skipping the top 5,000 rows (offset) and taking the next 100
    // (limit) lands entirely inside this batch: the first row on the page is
    // n = BATCH_SIZE - 5000 = 200 (counting from the top: rank 5001 overall
    // == the 5001st-most-recent row == n=200), descending to n=101.
    const firstN = BATCH_SIZE - 5000;
    expect(res.body.entries[0].track_title).toBe(`${MARKER} #${firstN}`);
    expect(res.body.entries[99].track_title).toBe(`${MARKER} #${firstN - 99}`);

    // V2 wire shape sanity: flat discriminated-union track entry, not a raw
    // DB row (matches the existing V2 shape assertions in flowsheet.spec.js).
    for (const entry of res.body.entries) {
      expect(entry.entry_type).toBe('track');
      expect(entry.artist_name).toBe(MARKER);
      expect(entry).not.toHaveProperty('search_doc');
      expect(entry).not.toHaveProperty('metadata_attempt_at');
    }
  }, 30000);

  test('a page depth beyond MAX_OFFSET is rejected with 400, not a 500 or a hang', async () => {
    // page 501 * limit 100 = offset 50,100 > MAX_OFFSET (50,000).
    const res = await request.get('/flowsheet').query({ page: 501, limit: 100 }).send();

    expect(res.status).toBe(400);
  });
});
