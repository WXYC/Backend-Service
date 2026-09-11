/**
 * BS#2424 — PG-semantics pin for `library-etl`'s BATCHED compilation-track
 * insert.
 *
 * `importCompilationTracks` used to issue one awaited
 * `INSERT ... ON CONFLICT DO NOTHING` per row over ~140,617 upstream rows,
 * inside the release import's write transaction — measured at 12-15 minutes
 * per working run. It now builds chunked multi-row INSERTs (1,000 rows per
 * statement), which turns ~140,617 round trips into ~141.
 *
 * That rewrite rests on two Postgres properties, and both are asserted here
 * against the REAL `compilation_track_artist` table rather than a probe copy,
 * because both of its unique indexes are load-bearing:
 *
 *   - `ON CONFLICT DO NOTHING` must stay UNTARGETED. The table carries
 *     `cta_unique_idx` (library_id, artist_name, track_title) AND the partial
 *     `cta_unique_null_track_idx` (library_id, artist_name) WHERE
 *     track_title IS NULL (BS#1135, PG14 has no `NULLS NOT DISTINCT`). An
 *     untargeted clause arbitrates on both; naming a target would silently
 *     stop deduping the other.
 *   - Duplicates INSIDE one statement must be skipped, not inserted twice.
 *     `DO NOTHING` uses speculative insertion and sees rows inserted earlier
 *     in the same command (unlike `DO UPDATE`, which raises "cannot affect
 *     row a second time"). This is not hypothetical: upstream
 *     `COMPILATION_TRACK_ARTIST` holds 2,070 surplus rows that collide
 *     intra-table on exactly `cta_unique_idx`'s tuple, so the first
 *     production pass meets them.
 *
 * Hand-written SQL in the `library-etl-setwhere.spec.js` style — the
 * integration runner is babel-jest and cannot import the ETL's drizzle code.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row so we don't have to seed one to satisfy
// the FK (see `tests/fixtures/shape.sql`; `migrations.spec.js` asserts it
// loaded). Same anchor `cta-unique-null-track-partial.spec.js` uses.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;

// High-entropy namespace so this spec cannot collide with fixture rows or
// with other specs sharing the per-worker schema.
const TEST_ARTIST = 'BS#2424 Batched CTA Probe';
const TEST_ARTIST_NULL = 'BS#2424 Batched CTA Probe (null track)';

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

/**
 * The batched write exactly as the job issues it: one multi-row VALUES list,
 * four columns, untargeted `ON CONFLICT DO NOTHING`.
 *
 * Returns the number of rows the statement actually wrote, which is NOT what
 * the job's `imported` counter reports — that deliberately still counts rows
 * handed to the insert (see `importCompilationTracks`).
 */
async function insertBatch(sql, rows) {
  const params = [];
  const tuples = rows.map((row) => {
    const base = params.length;
    params.push(row.library_id, row.artist_name, row.track_title, row.track_position);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  });
  const written = await sql.unsafe(
    `INSERT INTO "${SCHEMA}".compilation_track_artist
       (library_id, artist_name, track_title, track_position)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING
     RETURNING id`,
    params
  );
  return written.length;
}

const track = (title, position = null, artist = TEST_ARTIST) => ({
  library_id: SHAPE_FIXTURE_LIBRARY_ID,
  artist_name: artist,
  track_title: title,
  track_position: position,
});

describe('library-etl batched compilation-track insert (BS#2424)', () => {
  let sql;

  const countProbeRows = async () => {
    const rows = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM "${SCHEMA}".compilation_track_artist WHERE artist_name = ANY($1)`,
      [[TEST_ARTIST, TEST_ARTIST_NULL]]
    );
    return rows[0].n;
  };

  const clearProbeRows = () =>
    sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE artist_name = ANY($1)`, [
      [TEST_ARTIST, TEST_ARTIST_NULL],
    ]);

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) {
      await clearProbeRows();
      await sql.end();
    }
  });

  beforeEach(async () => {
    await clearProbeRows();
  });

  test('an intra-statement duplicate on (library_id, artist_name, track_title) inserts once and does not raise', async () => {
    // The 2,070-surplus-row case: the same credit appears twice in one
    // upstream chunk. Row-at-a-time this was two statements and the second
    // one no-opped; batched it is one statement that must dedupe against a
    // row it inserted itself, moments earlier, in the same command.
    const written = await insertBatch(sql, [
      track('Hex Suit', 'A1'),
      track('Hex Suit', 'A1'),
      track('Another Green World', 'A2'),
    ]);

    expect(written).toBe(2);
    expect(await countProbeRows()).toBe(2);
  });

  test('re-running an identical batch writes nothing and raises nothing', async () => {
    const batch = [track('Hex Suit', 'A1'), track('Another Green World', 'A2')];

    expect(await insertBatch(sql, batch)).toBe(2);
    // Idempotence is what makes the periodic full reconciliation pass cheap:
    // a full pass re-offers all ~140k rows and writes only what is new.
    expect(await insertBatch(sql, batch)).toBe(0);
    expect(await countProbeRows()).toBe(2);
  });

  test('a batch mixing new, already-present and intra-batch-duplicate rows lands exactly the new distinct rows', async () => {
    await insertBatch(sql, [track('Hex Suit', 'A1')]);

    const written = await insertBatch(sql, [
      track('Hex Suit', 'A1'), // already present
      track('Another Green World', 'A2'), // new
      track('Another Green World', 'A2'), // duplicate of the row above, same statement
      track('Sombre Détune', 'B1'), // new
    ]);

    expect(written).toBe(2);
    expect(await countProbeRows()).toBe(3);
  });

  test('the untargeted clause still arbitrates on the partial NULL-track index', async () => {
    // Upstream has zero NULL/blank `TRACK_TITLE` rows today, so this path is
    // not exercised by the importer in production — it is pinned because the
    // clause must stay untargeted for the day that changes. Naming
    // `cta_unique_idx` as the conflict target would let these three land as
    // three rows (PG14 treats NULLs as distinct in the base index) and only
    // the partial index would catch it — as an ERROR, aborting the whole
    // 1,000-row statement and the transaction with it.
    const written = await insertBatch(sql, [
      track(null, 'A1', TEST_ARTIST_NULL),
      track(null, 'A2', TEST_ARTIST_NULL),
      track(null, null, TEST_ARTIST_NULL),
    ]);

    expect(written).toBe(1);
    expect(await countProbeRows()).toBe(1);
  });
});
