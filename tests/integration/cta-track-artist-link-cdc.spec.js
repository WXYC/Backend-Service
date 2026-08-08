/**
 * BS#1990 (#801 S1) — proves `cdc_compilation_track_artist` (migration
 * 0046) still fires after migration 0139 widens
 * `wxyc_schema.compilation_track_artist` with the three new nullable
 * columns (`track_artist_id`, `track_artist_link_confidence`,
 * `track_artist_link_method`), a btree on `track_artist_id`, and two GIN
 * trgm indexes on `artist_name` / `track_title`.
 *
 * `cdc_compilation_track_artist` is a plain `AFTER INSERT OR UPDATE OR
 * DELETE ... FOR EACH ROW EXECUTE FUNCTION cdc_notify()` trigger with no
 * column list (see migration 0046) — adding columns doesn't require
 * re-creating it, but the AC on BS#1990 calls for a positive test rather
 * than reasoning alone. This spec inserts a row with the new columns
 * populated and asserts the `cdc` NOTIFY payload carries them via
 * `to_jsonb(NEW)`.
 *
 * The companion watermark trigger (`touch_library_watermark_from_compilation_track_artist`,
 * migration 0138) is already covered by the pre-existing
 * `tests/integration/library-catalog-producer-export.spec.js` ("a
 * compilation_track_artist write advances the watermark..." test), which
 * continues to pass unmodified against the widened table.
 *
 * Pure SQL (babel-jest runner, no TS import) — same LISTEN/NOTIFY pattern as
 * `cdc-oversized-fallback.spec.js` / `flowsheet-etl-cdc-delivery.spec.js`.
 */

const postgres = require('postgres');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for a valid library_id FK.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;
const TEST_ARTIST = 'BS#1990 CDC Trigger Probe';

async function waitForEvent(events, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('cdc_compilation_track_artist still fires after the widening migration (BS#1990)', () => {
  let sql;
  let listenConn;
  const cdcEvents = [];
  let artistId;

  beforeAll(async () => {
    sql = getTestDb();
    listenConn = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      username: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });
    await listenConn.listen('cdc', (payload) => {
      try {
        cdcEvents.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    });

    // A real artists.id to exercise the new track_artist_id FK end-to-end.
    const rows = await sql.unsafe(`SELECT id FROM "${SCHEMA}".artists ORDER BY id LIMIT 1`);
    if (!rows[0]) {
      throw new Error('no artists row available to satisfy track_artist_id FK — is the shape fixture loaded?');
    }
    artistId = rows[0].id;
  });

  afterAll(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE artist_name = $1`, [TEST_ARTIST]);
    if (listenConn) await listenConn.end();
  });

  beforeEach(() => {
    cdcEvents.length = 0;
  });

  test('an INSERT with the new columns populated fires `cdc` carrying them', async () => {
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist
         (library_id, artist_name, track_title, track_artist_id, track_artist_link_confidence, track_artist_link_method)
       VALUES ($1, $2, 'CDC Probe Track', $3, 0.9, 'librarian')
       RETURNING id`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST, artistId]
    );
    const id = rows[0].id;

    const event = await waitForEvent(cdcEvents, (e) => e.table === 'compilation_track_artist' && e.data?.id === id);
    expect(event).not.toBeNull();
    expect(event.action).toBe('INSERT');
    expect(event.data.track_artist_id).toBe(artistId);
    expect(event.data.track_artist_link_confidence).toBeCloseTo(0.9);
    expect(event.data.track_artist_link_method).toBe('librarian');
  });

  test('an UPDATE that only touches a new column still fires `cdc`', async () => {
    const inserted = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title)
       VALUES ($1, $2, 'CDC Probe Update Track')
       RETURNING id`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );
    const id = inserted[0].id;

    // Wait for the INSERT's own `cdc` event to land before clearing — NOTIFY
    // delivery is async, so clearing immediately after the INSERT can race
    // it and leave the INSERT event to falsely satisfy the UPDATE wait below.
    await waitForEvent(cdcEvents, (e) => e.table === 'compilation_track_artist' && e.data?.id === id);
    cdcEvents.length = 0;

    await sql.unsafe(`UPDATE "${SCHEMA}".compilation_track_artist SET track_artist_link_method = $1 WHERE id = $2`, [
      'lml_backfill',
      id,
    ]);

    const event = await waitForEvent(
      cdcEvents,
      (e) => e.table === 'compilation_track_artist' && e.data?.id === id && e.action === 'UPDATE'
    );
    expect(event).not.toBeNull();
    expect(event.data.track_artist_link_method).toBe('lml_backfill');
  });
});
