/**
 * Integration test for the playlist-proxy artwork tie-break contract
 * (BS#1105), against a REAL Postgres.
 *
 * `enrichPlaycuts` / `enrichSinglePlaycut` in
 * `apps/backend/services/playlist-proxy.service.ts` join `flowsheet` to
 * `album_metadata` via `flowsheet.album_id`. Per the `library` schema
 * comment (`shared/database/src/schema.ts`, "Multiple library rows pointing
 * at the same (artists.id, album_title)"), the legacy library is
 * per-physical-format: a CD and an LP issue of the same album are distinct
 * `library` rows, each with its own `album_metadata.artwork_url`. Before the
 * fix, the batch query grouped by `(flowsheetLookupKey, artwork_url)` and
 * the single-entry query had no `ORDER BY` before `LIMIT 1` — both let
 * Postgres row order (unspecified without an explicit ORDER BY) decide
 * which format's artwork won, non-deterministically across runs.
 *
 * DECISION: tie-break = lowest `album_id` wins. This spec mirrors the fixed
 * SQL directly (pure SQL, no TS import — the integration runner is
 * babel-jest with no TS support; see `album-metadata-upsert.spec.js` and
 * `album-popularity-refresh.spec.js` for the same division of
 * responsibility). When the service's query shape changes, this SQL must
 * follow.
 *
 * Unit coverage (`tests/unit/services/playlist-proxy.service.test.ts`)
 * covers the Drizzle builder shape (array_agg/orderBy wiring); this spec
 * covers the actual PostgreSQL non-determinism this fixes.
 *
 * Probe rows live in the reserved 7150-range, reusing fixture artist 7000
 * ('XA'), genre 11 ('Rock'), format 1 ('cd') — see
 * `album-popularity-refresh.spec.js` for the same shared fixture.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'

const PRESS_CD = 7150; // lower album_id -> must win the tie-break
const PRESS_LP = 7151; // higher album_id, same artist+album, distinct artwork

const ARTIST_NAME = 'BS1105 Split Format Artist';
const ALBUM_TITLE = 'BS1105 Split Format Album';
const LOOKUP_KEY = `${ARTIST_NAME.toLowerCase().trim()}-${ALBUM_TITLE.toLowerCase().trim()}`;

const CD_ARTWORK = 'https://i.discogs.com/bs1105-cd.jpg';
const LP_ARTWORK = 'https://i.discogs.com/bs1105-lp.jpg';

async function seedLibrary(sql, id, codeNumber) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES (${id}, ${ART}, ${GEN}, ${FMT}, ${ALBUM_TITLE}, ${codeNumber}, ${ARTIST_NAME})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedAlbumMetadata(sql, albumId, artworkUrl) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url)
    VALUES (${albumId}, ${artworkUrl})
    ON CONFLICT (album_id) DO UPDATE SET artwork_url = EXCLUDED.artwork_url
  `;
}

async function seedPlay(sql, albumId, playOrder) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (album_id, entry_type, play_order, artist_name, album_title, track_title)
    VALUES (${albumId}, 'track', ${playOrder}, ${ARTIST_NAME}, ${ALBUM_TITLE}, 'probe track')
  `;
}

/**
 * Mirror of the FIXED `enrichPlaycuts` batch query: group by lookup key
 * alone, fold candidate artwork_urls through array_agg ordered by album_id
 * ascending, take the first element.
 */
async function batchQuery(sql, keys) {
  return sql`
    SELECT
      (lower(trim(f.artist_name)) || '-' || lower(trim(coalesce(f.album_title, '')))) AS "key",
      (array_agg(am.artwork_url ORDER BY am.album_id ASC))[1] AS "artwork_url"
    FROM ${sql(SCHEMA)}.flowsheet f
    INNER JOIN ${sql(SCHEMA)}.album_metadata am ON am.album_id = f.album_id
    WHERE (lower(trim(f.artist_name)) || '-' || lower(trim(coalesce(f.album_title, '')))) = ANY(${keys})
      AND am.artwork_url IS NOT NULL
    GROUP BY (lower(trim(f.artist_name)) || '-' || lower(trim(coalesce(f.album_title, ''))))
  `;
}

/**
 * Mirror of the FIXED `enrichSinglePlaycut` query: same JOIN + filter,
 * explicit ORDER BY album_id ASC before LIMIT 1.
 */
async function singleQuery(sql, key) {
  return sql`
    SELECT am.artwork_url AS "artwork_url"
    FROM ${sql(SCHEMA)}.flowsheet f
    INNER JOIN ${sql(SCHEMA)}.album_metadata am ON am.album_id = f.album_id
    WHERE (lower(trim(f.artist_name)) || '-' || lower(trim(coalesce(f.album_title, '')))) = ${key}
      AND am.artwork_url IS NOT NULL
    ORDER BY am.album_id ASC
    LIMIT 1
  `;
}

/** Mirror of the PRE-FIX batch query (grouped by key + artwork_url, no tie-break). */
async function preFixBatchQuery(sql, keys) {
  return sql`
    SELECT
      (lower(trim(f.artist_name)) || '-' || lower(trim(coalesce(f.album_title, '')))) AS "key",
      am.artwork_url AS "artwork_url"
    FROM ${sql(SCHEMA)}.flowsheet f
    INNER JOIN ${sql(SCHEMA)}.album_metadata am ON am.album_id = f.album_id
    WHERE (lower(trim(f.artist_name)) || '-' || lower(trim(coalesce(f.album_title, '')))) = ANY(${keys})
      AND am.artwork_url IS NOT NULL
    GROUP BY (lower(trim(f.artist_name)) || '-' || lower(trim(coalesce(f.album_title, '')))), am.artwork_url
  `;
}

describe('playlist-proxy artwork tie-break for split-format albums (real PG, BS#1105)', () => {
  let sql;
  const libraryIds = [PRESS_CD, PRESS_LP];

  beforeAll(async () => {
    sql = getTestDb();

    await seedLibrary(sql, PRESS_CD, 150);
    await seedLibrary(sql, PRESS_LP, 151);
    await seedAlbumMetadata(sql, PRESS_CD, CD_ARTWORK);
    await seedAlbumMetadata(sql, PRESS_LP, LP_ARTWORK);
    await seedPlay(sql, PRESS_CD, 9150);
    await seedPlay(sql, PRESS_LP, 9151);
  });

  afterAll(async () => {
    if (!sql) return;
    for (const id of libraryIds) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE album_id = ${id}`;
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${libraryIds})`;
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
  });

  it('pre-fix query shape demonstrates the bug: two rows for one lookup key', async () => {
    // Documents the failure this ticket fixes: grouping by (key, artwork_url)
    // returns one row per distinct artwork_url sharing the key, so a
    // last-write-wins Map.set over the result set is order-dependent.
    const rows = await preFixBatchQuery(sql, [LOOKUP_KEY]);
    expect(rows).toHaveLength(2);
    const artworkUrls = rows.map((r) => r.artwork_url).sort();
    expect(artworkUrls).toEqual([CD_ARTWORK, LP_ARTWORK].sort());
  });

  it('fixed batch query returns exactly one deterministic row per lookup key', async () => {
    const rows = await batchQuery(sql, [LOOKUP_KEY]);
    expect(rows).toHaveLength(1);
    expect(rows[0].artwork_url).toBe(CD_ARTWORK); // lowest album_id (PRESS_CD) wins
  });

  it('fixed batch query returns the identical artwork_url across repeated runs', async () => {
    const first = await batchQuery(sql, [LOOKUP_KEY]);
    const second = await batchQuery(sql, [LOOKUP_KEY]);
    const third = await batchQuery(sql, [LOOKUP_KEY]);

    expect(first[0].artwork_url).toBe(CD_ARTWORK);
    expect(second[0].artwork_url).toBe(CD_ARTWORK);
    expect(third[0].artwork_url).toBe(CD_ARTWORK);
  });

  it('fixed single-entry query (ORDER BY + LIMIT 1) returns the lowest album_id row deterministically', async () => {
    const first = await singleQuery(sql, LOOKUP_KEY);
    const second = await singleQuery(sql, LOOKUP_KEY);

    expect(first).toHaveLength(1);
    expect(first[0].artwork_url).toBe(CD_ARTWORK);
    expect(second[0].artwork_url).toBe(CD_ARTWORK);
  });
});
