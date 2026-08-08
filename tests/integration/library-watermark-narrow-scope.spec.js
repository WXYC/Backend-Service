/**
 * BS#2052 — narrow `touch_library_watermark`'s `library` trigger from an
 * unqualified `UPDATE` to `UPDATE OF <exported columns>` (migration 0141).
 *
 * Companion to `library-watermark.spec.js` (#1467, the original trigger) and
 * `library-watermark-parents.spec.js` (#1468, the parent-table fan-out).
 * Those specs pin that INSERT/UPDATE/DELETE all advance the watermark; this
 * one pins the NEW invariant 0141 adds on top: an UPDATE that touches only a
 * non-exported column must NOT advance it, while an UPDATE that touches an
 * exported column still must.
 *
 * The motivating case is `library.unresolved_attempted_at`
 * (`jobs/library-identity-consumer`'s per-batch drain marker, migration
 * 0130/BS#974): a genuine row change, but one no catalog export ever reads.
 * Before 0141, every `--recheck` sweep bumped `library_watermark` once per
 * batch and busted every client's conditional GET for a change nobody could
 * observe. This spec exercises that exact column plus one true positive
 * (`album_artist`, part of `CatalogExportRow` per
 * `apps/backend/services/catalog-export.service.ts`).
 *
 * Postgres-dependent integration test (the BS analogue of the org `pg`
 * marker): every mutation is raw SQL straight against the test DB, standing
 * in for `jobs/library-identity-consumer`'s writer, which writes via the
 * Drizzle client but is not `library.service` and so cannot be spied on at
 * the app layer.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for valid FK values
// (artist_id / genre_id / format_id). The fixture lives in
// `tests/fixtures/shape.sql`; globalSetup loads it before any spec runs.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;

// Namespace probe rows by album_title so cleanup is surgical and we never
// touch fixture rows other --runInBand specs depend on.
const TITLE_PREFIX = 'BS#2052 WM Narrow Probe';

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

describe('library_watermark trigger scope narrowing (BS#2052)', () => {
  let sql;
  let fk; // { artist_id, genre_id, format_id } pulled from row 7000

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
      await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
  });

  // Age the watermark to a known past instant via a direct write to the
  // watermark table. That write does NOT fire the trigger (the trigger is on
  // `library`), so it gives each case a deterministic "stale" baseline that a
  // fired trigger must then advance back to ≈now() — and that a trigger which
  // correctly declines to fire must leave untouched.
  const ageWm = async (interval) =>
    sql.unsafe(
      `UPDATE "${SCHEMA}".library_watermark SET last_modified_at = now() - interval '${interval}' WHERE id = true`
    );

  // Evaluated entirely in SQL against the DB clock — no JS-vs-DB clock skew.
  const advancedToNow = async () => {
    const rows = await sql.unsafe(
      `SELECT (last_modified_at >= now() - interval '1 minute'
              AND last_modified_at <= now() + interval '1 second') AS ok
       FROM "${SCHEMA}".library_watermark WHERE id = true`
    );
    return rows[0].ok;
  };

  const stillAged = async () => {
    const rows = await sql.unsafe(
      `SELECT last_modified_at < now() - interval '50 years' AS unchanged
       FROM "${SCHEMA}".library_watermark WHERE id = true`
    );
    return rows[0].unchanged;
  };

  // Insert a probe library row; returns its id.
  const insertProbeRow = async (suffix) => {
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fk.artist_id, fk.genre_id, fk.format_id, `${TITLE_PREFIX} ${suffix}`, 0]
    );
    return rows[0].id;
  };

  test('UPDATE of library.unresolved_attempted_at alone does NOT advance the watermark (the BS#974 batch-stamp no longer busts conditional GET)', async () => {
    const id = await insertProbeRow('unresolved-attempted-at');
    // 100 years, matching library-watermark.spec.js's "no mutating statement"
    // case, so an unambiguous failure to stay put is obvious.
    await ageWm('100 years');

    // The exact shape jobs/library-identity-consumer's writer.ts stamps: a
    // genuine NOW() row change on this column alone, once per batch.
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET unresolved_attempted_at = now() WHERE id = $1`, [id]);

    expect(await stillAged()).toBe(true);
  });

  test('UPDATE of an exported column (album_artist) still advances the watermark', async () => {
    const id = await insertProbeRow('album-artist');
    await ageWm('1 hour');

    await sql.unsafe(`UPDATE "${SCHEMA}".library SET album_artist = 'BS#2052 changed' WHERE id = $1`, [id]);

    expect(await advancedToNow()).toBe(true);
  });

  test('a single UPDATE touching both an exported and a non-exported column still advances the watermark', async () => {
    const id = await insertProbeRow('mixed-columns');
    await ageWm('1 hour');

    // Postgres fires `UPDATE OF <cols>` when the statement's SET clause
    // mentions ANY listed column, so a batch write that (incidentally) also
    // touches unresolved_attempted_at alongside an exported field must still
    // advance the watermark.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".library SET album_artist = 'BS#2052 mixed', unresolved_attempted_at = now() WHERE id = $1`,
      [id]
    );

    expect(await advancedToNow()).toBe(true);
  });

  test('INSERT and DELETE stay unqualified and still advance the watermark regardless of column set', async () => {
    await ageWm('1 hour');
    const id = await insertProbeRow('insert-delete');
    expect(await advancedToNow()).toBe(true);

    await ageWm('1 hour');
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = $1`, [id]);
    expect(await advancedToNow()).toBe(true);
  });
});
