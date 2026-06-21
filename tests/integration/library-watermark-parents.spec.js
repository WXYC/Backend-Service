/**
 * BS#1468 (Epic F pattern, parent #1466) — `library_watermark` parent-table
 * fan-out (migration 0105). Companion to `library-watermark.spec.js` (#1467,
 * the `library`-only trigger).
 *
 * The bulk-export endpoint (`GET /library/catalog`) projects display fields that
 * are NOT physical `library` columns — `code_letters` (artists),
 * `code_artist_number` (genre_artist_crossreference), `genre_name` (genres),
 * `format_name` (format), and raw `rotation_bin` / `rotation_kill_date`
 * (rotation). A rename/curation write on any of those parents touches no
 * `library` row, so without a trigger there the watermark would stay put and a
 * polling client would `304` against a stale name. Migration 0105 attaches the
 * SAME `touch_library_watermark()` statement trigger to all five parents; this
 * spec asserts each one advances the watermark — the "coverage invariant" AC.
 *
 * Postgres-dependent (the BS analogue of the org `pg` marker): every mutation is
 * raw SQL straight against the test DB, also standing in for the ETL writers
 * that bypass the BS app layer. The schema-source parity guard lives in the
 * migration validator; this spec is the runtime behavior assertion.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for valid FK values.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;
const TITLE_PREFIX = 'BS#1468 WM Parent Probe';

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

describe('library_watermark parent-table triggers (BS#1468)', () => {
  let sql;
  let fk; // { artist_id, genre_id, format_id } from row 7000

  beforeAll(async () => {
    sql = makeSql();
    const rows = await sql.unsafe(`SELECT artist_id, genre_id, format_id FROM "${SCHEMA}".library WHERE id = $1`, [
      SHAPE_FIXTURE_LIBRARY_ID,
    ]);
    fk = rows[0];
    if (!fk) {
      throw new Error(
        `shape fixture library row ${SHAPE_FIXTURE_LIBRARY_ID} not found in schema "${SCHEMA}" — globalSetup should load tests/fixtures/shape.sql before any spec`
      );
    }
  });

  afterAll(async () => {
    if (sql) {
      // rotation.album_id references library.id ON DELETE CASCADE, so deleting
      // the probe library rows reaps the probe rotation rows too.
      await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
  });

  // Age the watermark to a known past instant via a direct write to the
  // watermark table — that write does NOT fire any trigger (triggers are on the
  // parents, not on library_watermark), giving each case a deterministic stale
  // baseline a fired trigger must advance back to ≈now().
  const ageWm = async (interval) =>
    sql.unsafe(
      `UPDATE "${SCHEMA}".library_watermark SET last_modified_at = now() - interval '${interval}' WHERE id = true`
    );

  // Evaluated entirely in SQL against the DB clock — no JS-vs-DB skew.
  const advancedToNow = async () => {
    const rows = await sql.unsafe(
      `SELECT (last_modified_at >= now() - interval '1 minute'
              AND last_modified_at <= now() + interval '1 second') AS ok
       FROM "${SCHEMA}".library_watermark WHERE id = true`
    );
    return rows[0].ok;
  };

  test('a write on artists advances the watermark (code_letters: cascade-inert, isolates the new trigger)', async () => {
    await ageWm('1 hour');
    // code_letters is NOT cascaded by the 0060 trigger (it fires only
    // `AFTER UPDATE OF artist_name`), so this advance comes solely from the new
    // artists statement trigger — not from a cascaded `UPDATE library`.
    await sql.unsafe(`UPDATE "${SCHEMA}".artists SET code_letters = code_letters WHERE id = $1`, [fk.artist_id]);
    expect(await advancedToNow()).toBe(true);
  });

  test('a write on genres advances the watermark', async () => {
    await ageWm('1 hour');
    await sql.unsafe(`UPDATE "${SCHEMA}".genres SET genre_name = genre_name WHERE id = $1`, [fk.genre_id]);
    expect(await advancedToNow()).toBe(true);
  });

  test('a write on format advances the watermark', async () => {
    await ageWm('1 hour');
    await sql.unsafe(`UPDATE "${SCHEMA}".format SET format_name = format_name WHERE id = $1`, [fk.format_id]);
    expect(await advancedToNow()).toBe(true);
  });

  test('a write on genre_artist_crossreference advances the watermark', async () => {
    await ageWm('1 hour');
    await sql.unsafe(
      `UPDATE "${SCHEMA}".genre_artist_crossreference SET artist_genre_code = artist_genre_code
       WHERE artist_id = $1 AND genre_id = $2`,
      [fk.artist_id, fk.genre_id]
    );
    expect(await advancedToNow()).toBe(true);
  });

  test('an INSERT on rotation advances the watermark (continuous curation moves freshness)', async () => {
    // A probe library row gives a valid album_id FK. (Its own INSERT fires the
    // library trigger; we age the watermark AFTER it so the rotation INSERT is
    // the event under test.)
    const lib = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fk.artist_id, fk.genre_id, fk.format_id, `${TITLE_PREFIX} rotation`, 0]
    );
    await ageWm('1 hour');
    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H')`, [lib[0].id]);
    expect(await advancedToNow()).toBe(true);
  });
});
