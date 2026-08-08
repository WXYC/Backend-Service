/**
 * BS#2054 — narrow `touch_library_watermark_from_compilation_track_artist`'s
 * `UPDATE` leg from unqualified to `UPDATE OF <exported columns>` (migration
 * 0143), the deferred sibling of BS#2052's identical narrowing on `library`
 * (migration 0142).
 *
 * Companion to `library-watermark-narrow-scope.spec.js` (#2052, the same
 * narrowing on `library`) and `cta-track-artist-link-cdc.spec.js` (#1990,
 * which pins that `cdc_compilation_track_artist` — a separate, untouched,
 * `FOR EACH ROW` trigger — still fires regardless of this migration).
 * `library-catalog-producer-export.spec.js`'s "a compilation_track_artist
 * write advances the watermark" test already pins INSERT; this spec pins the
 * NEW invariant 0143 adds on top: an UPDATE that touches only a column
 * `getCompilationTrackExportRows()` never reads must NOT advance the
 * watermark, while an UPDATE that touches a column it does read still must.
 *
 * The motivating case is `jobs/library-identity-consumer`'s
 * `writeCompilationTracks` (migration 0140 / BS#1990-1991): every per-track
 * identity write sets `track_artist_id` / `track_artist_link_confidence` /
 * `track_artist_link_method` / `track_position`, none of which the CTA export
 * projects or joins on. Before 0143, a first-time resolution (a genuine value
 * change, NOT filtered by #1991's app-side no-op guard — see
 * `cta-noop-redrain-watermark.spec.js` for that distinct guarantee) advanced
 * `library_watermark` for a change no client could observe. This spec
 * exercises those four columns plus the three the export DOES read:
 * `artist_name` / `track_title` (projected) and `library_id` (the join key
 * back to `library` that determines which `legacy_release_id` the row is
 * attributed to — see migration 0143's header for the full derivation,
 * including why `library_id` belongs on the watch list even though it is
 * never projected directly).
 *
 * `UPDATE OF col` is target-list-based, not value-change-based: it fires
 * because a statement's SET clause NAMES a watched column, whether or not the
 * value actually changes. Nothing here claims the trigger only fires on real
 * changes.
 *
 * Postgres-dependent integration test (the BS analogue of the org `pg`
 * marker): every mutation is raw SQL straight against the test DB, same
 * pattern as `library-watermark-narrow-scope.spec.js` and
 * `cta-noop-redrain-watermark.spec.js`.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for a valid library_id FK —
// same convention as cta-noop-redrain-watermark.spec.js /
// cta-track-artist-link-cdc.spec.js.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;

// Namespace probe rows by artist_name so cleanup is surgical and never
// touches fixture rows other --runInBand specs depend on.
const TITLE_PREFIX = 'BS#2054 WM Narrow Probe';

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

describe('compilation_track_artist watermark trigger scope narrowing (BS#2054)', () => {
  let sql;
  let artistId;

  beforeAll(async () => {
    sql = makeSql();
    const artistRows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZS') RETURNING id`,
      [`${TITLE_PREFIX} Artist`]
    );
    artistId = artistRows[0].id;
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE artist_name LIKE $1`, [
        `${TITLE_PREFIX}%`,
      ]);
      await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE id = $1`, [artistId]);
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE artist_name LIKE $1`, [
      `${TITLE_PREFIX}%`,
    ]);
  });

  // Age the watermark to a known past instant via a direct write to the
  // watermark table — mirrors library-watermark-narrow-scope.spec.js. That
  // write does NOT fire the CTA trigger (the trigger is on
  // compilation_track_artist), so it gives each case a deterministic "stale"
  // baseline that a fired trigger must advance back to ≈now(), and that a
  // trigger which correctly declines to fire must leave untouched.
  const ageWm = async (interval) =>
    sql.unsafe(
      `UPDATE "${SCHEMA}".library_watermark SET last_modified_at = now() - interval '${interval}' WHERE id = true`
    );

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

  const insertProbeRow = async (suffix) => {
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title)
       VALUES ($1, $2, 'Probe Track') RETURNING id`,
      [SHAPE_FIXTURE_LIBRARY_ID, `${TITLE_PREFIX} ${suffix}`]
    );
    return rows[0].id;
  };

  test.each([
    ['track_artist_id', () => artistId],
    ['track_artist_link_confidence', () => 0.5],
    ['track_artist_link_method', () => 'librarian'],
    ['track_position', () => 'A1'],
  ])(
    'UPDATE of %s alone does NOT advance the watermark (writeCompilationTracks writes this column; the export never reads it)',
    async (column, value) => {
      const id = await insertProbeRow(column);
      await ageWm('100 years');

      await sql.unsafe(`UPDATE "${SCHEMA}".compilation_track_artist SET "${column}" = $1 WHERE id = $2`, [value(), id]);

      expect(await stillAged()).toBe(true);
    }
  );

  test.each(['artist_name', 'track_title'])(
    'UPDATE of an exported column (%s) still advances the watermark',
    async (column) => {
      const id = await insertProbeRow(`exported-${column}`);
      await ageWm('1 hour');

      await sql.unsafe(`UPDATE "${SCHEMA}".compilation_track_artist SET "${column}" = $1 WHERE id = $2`, [
        `${TITLE_PREFIX} changed ${column}`,
        id,
      ]);

      expect(await advancedToNow()).toBe(true);
    }
  );

  test('UPDATE of library_id (the join key back to `library`) still advances the watermark', async () => {
    const id = await insertProbeRow('library-id');
    await ageWm('1 hour');

    // Self-assignment: the point is that the column is NAMED in the SET
    // list, not that the value changes — UPDATE OF is target-list-based.
    await sql.unsafe(`UPDATE "${SCHEMA}".compilation_track_artist SET library_id = library_id WHERE id = $1`, [id]);

    expect(await advancedToNow()).toBe(true);
  });

  test('a single UPDATE touching both an exported and a non-exported column still advances the watermark', async () => {
    const id = await insertProbeRow('mixed-columns');
    await ageWm('1 hour');

    // Postgres fires `UPDATE OF <cols>` when the statement's SET clause
    // mentions ANY listed column, so a batch write that (incidentally) also
    // touches track_artist_id alongside an exported field must still advance
    // the watermark.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".compilation_track_artist SET artist_name = $1, track_artist_id = $2 WHERE id = $3`,
      [`${TITLE_PREFIX} mixed changed`, artistId, id]
    );

    expect(await advancedToNow()).toBe(true);
  });

  test('INSERT and DELETE stay unqualified and still advance the watermark regardless of column set', async () => {
    await ageWm('1 hour');
    const id = await insertProbeRow('insert-delete');
    expect(await advancedToNow()).toBe(true);

    await ageWm('1 hour');
    await sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE id = $1`, [id]);
    expect(await advancedToNow()).toBe(true);
  });
});
