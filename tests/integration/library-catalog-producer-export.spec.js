/**
 * BS#1965 — the Backend-sourced library.db producer path.
 *
 * Extends the BS#1468 catalog export with the four fields the Option-B producer
 * (discogs-etl#351) needs to build a byte-parity library.db over HTTP
 * (legacy_release_id, album_artist, alternate_artist_name, cross_reference_names),
 * and adds the sibling CTA export GET /library/catalog/compilation-tracks that
 * feeds library.db's compilation_track_artist table.
 *
 * Also covers the three things the merged SSOT (WXYC/wxyc-shared#293) makes
 * load-bearing and that no unit test can reach:
 *   - cross_reference_names is an ARRAY ordered by Unicode code point
 *     (COLLATE "C"), not the pipe-joined string and not the locale default;
 *   - the CTA export applies the SAME 4-INNER-JOIN row-eligibility predicate as
 *     /library/catalog, so no CTA key joins to nothing in the produced library.db;
 *   - migration 0138's watermark triggers, without which a cross-reference or
 *     CTA write is invisible to the conditional GET silently and unboundedly.
 *
 * Postgres-backed (the BS analogue of the org `pg` marker): direct SQL seeds
 * isolated fixtures, supertest drives the HTTP surface. All seeded rows live in a
 * dedicated 7170-range this spec owns end-to-end (created + reaped here), so it
 * can't collide with the shared shape fixture or the 7050-range the sibling
 * catalog-export spec uses.
 */

const zlib = require('zlib');
const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'

// Isolated artists: a "main" filing artist + three cross-reference partners.
const ART_MAIN = 7170;
const ART_XREF_A = 7171; // 'BS1965 Xref Beta'
const ART_XREF_B = 7172; // 'BS1965 Xref Gamma'
const ART_XREF_C = 7175; // 'bs1965 Xref Delta' — lowercase initial, the collation probe
const XREF_A_NAME = 'BS1965 Xref Beta';
const XREF_B_NAME = 'BS1965 Xref Gamma';
const XREF_C_NAME = 'bs1965 Xref Delta';

// Deduplicated, bidirectional, ordered by UNICODE CODE POINT (Postgres
// COLLATE "C") — an ARRAY on the wire, never the pipe-joined string library.db
// stores (the producer does that join itself).
//
// The lowercase-initial third name is the load-bearing part of this fixture.
// Under COLLATE "C", 'b' (U+0062) sorts after 'B' (U+0042), so Delta lands LAST:
//   ['BS1965 Xref Beta', 'BS1965 Xref Gamma', 'bs1965 Xref Delta']
// Under the database's default en_US.UTF-8 collation, case is ignored at the
// primary level and Delta would sort BETWEEN Beta and Gamma. The two orderings
// disagree, so this array pins that the query really is collation-explicit
// rather than accidentally passing on the local database's default.
const EXPECTED_XREF = [XREF_A_NAME, XREF_B_NAME, XREF_C_NAME];

const LIB_PRODUCER = 7173; // library row under ART_MAIN, with album_artist + alternate
const LIB_CTA = 7174; // library row under ART_MAIN that owns the seeded CTA rows

// Row-eligibility probe: an artist deliberately given NO genre_artist_crossreference
// entry for GEN, so its library row fails the catalog export's 4-INNER-JOIN
// predicate. Its CTA rows must be dropped from the CTA export too.
const ART_NO_GAC = 7176;
const LIB_NO_GAC = 7177;

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

function collectBuffer(res, cb) {
  const chunks = [];
  res.on('data', (d) => chunks.push(Buffer.from(d)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
function decodeBody(res) {
  let buf = Buffer.isBuffer(res.body) && res.body.length ? res.body : Buffer.from(res.text || '', 'utf8');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}
function parseRows(res) {
  return decodeBody(res)
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}
const getCatalog = (auth) => auth.get('/library/catalog').buffer(true).parse(collectBuffer);
const getCta = (auth) => auth.get('/library/catalog/compilation-tracks').buffer(true).parse(collectBuffer);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('GET /library/catalog + /compilation-tracks — library.db producer path (BS#1965)', () => {
  let auth;
  let sql;
  let mainLegacyId; // minted legacy_release_id of LIB_PRODUCER (queried at runtime)
  let ctaLegacyId; // minted legacy_release_id of LIB_CTA
  let noGacLegacyId; // minted legacy_release_id of the export-ineligible LIB_NO_GAC

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // Isolated artists + genre crossref so the export's INNER JOINs resolve.
    // ART_NO_GAC deliberately gets NO genre_artist_crossreference row (below).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (id, artist_name, alphabetical_name, code_letters)
       VALUES ($1, 'BS1965 Main Filing Artist', 'BS1965 Main Filing Artist', 'ZA'),
              ($2, $5, $5, 'ZB'),
              ($3, $6, $6, 'ZC'),
              ($4, $7, $7, 'ZD'),
              ($8, 'BS1965 Ineligible Artist', 'BS1965 Ineligible Artist', 'ZE')
       ON CONFLICT (id) DO NOTHING`,
      [ART_MAIN, ART_XREF_A, ART_XREF_B, ART_XREF_C, XREF_A_NAME, XREF_B_NAME, XREF_C_NAME, ART_NO_GAC]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $5, 970), ($2, $5, 971), ($3, $5, 972), ($4, $5, 973)
       ON CONFLICT (artist_id, genre_id) DO NOTHING`,
      [ART_MAIN, ART_XREF_A, ART_XREF_B, ART_XREF_C, GEN]
    );

    // Cross-references in BOTH FK directions, plus a redundant reverse row and a
    // self-reference, to prove the export folds both directions, dedups, and
    // excludes the row's own artist: ART_MAIN -> A (forward), A -> ART_MAIN
    // (redundant reverse; must NOT double 'Beta'), B -> ART_MAIN (reverse only),
    // ART_MAIN -> C (the collation probe), and ART_MAIN -> ART_MAIN (self; must
    // NOT appear — LML would otherwise match the artist against itself).
    // Expected result for ART_MAIN: {Beta, Gamma, delta}, C-ordered.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_crossreference (source_artist_id, target_artist_id, comment)
       VALUES ($1, $2, 'forward'), ($2, $1, 'reverse-dup'), ($3, $1, 'reverse-only'),
              ($1, $4, 'collation-probe'), ($1, $1, 'self-reference')
       ON CONFLICT (source_artist_id, target_artist_id) DO NOTHING`,
      [ART_MAIN, ART_XREF_A, ART_XREF_B, ART_XREF_C]
    );

    // Producer-fields probe: album_artist + alternate_artist_name populated.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, album_artist, alternate_artist_name)
       VALUES ($1, $2, $3, $4, 'BS1965 Producer Probe', 71, 'BS1965 Main Filing Artist', 'Various Artists', 'V/A')
       ON CONFLICT (id) DO NOTHING`,
      [LIB_PRODUCER, ART_MAIN, GEN, FMT]
    );

    // CTA-owning library row + its compilation tracks (one with a NULL track_title
    // to exercise the nullable column end-to-end).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 'BS1965 CTA Compilation', 72, 'BS1965 Main Filing Artist')
       ON CONFLICT (id) DO NOTHING`,
      [LIB_CTA, ART_MAIN, GEN, FMT]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title, track_position)
       VALUES ($1, 'Chuquimamani-Condori', 'Call Your Name', 'A1'),
              ($1, 'DJ E, Chuquimamani-Condori', 'Wayño', 'A2'),
              ($1, 'Juana Molina', NULL, NULL)`,
      [LIB_CTA]
    );

    // Row-eligibility probe: a library row whose (artist_id, genre_id) pair has
    // NO genre_artist_crossreference entry, so the catalog export's INNER JOIN
    // drops it. It owns a CTA row, which must be dropped from the CTA export too.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 'BS1965 Ineligible Compilation', 73, 'BS1965 Ineligible Artist')
       ON CONFLICT (id) DO NOTHING`,
      [LIB_NO_GAC, ART_NO_GAC, GEN, FMT]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title, track_position)
       VALUES ($1, 'BS1965 Orphan Track Artist', 'Should Not Be Exported', 'B1')`,
      [LIB_NO_GAC]
    );

    // Capture the minted legacy_release_ids (BS#1963 nextval default; not
    // hardcodable) so assertions bind to the real surrogate keys.
    const mainRow = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [LIB_PRODUCER]);
    const ctaRow = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [LIB_CTA]);
    const noGacRow = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [LIB_NO_GAC]);
    mainLegacyId = mainRow[0].legacy_release_id;
    ctaLegacyId = ctaRow[0].legacy_release_id;
    noGacLegacyId = noGacRow[0].legacy_release_id;
  });

  afterAll(async () => {
    if (sql) {
      // compilation_track_artist.library_id is ON DELETE CASCADE, so the library
      // delete reaps the seeded CTA rows. artist_crossreference has no FK to
      // library; reap it explicitly. Delete library rows before artists (FK).
      const artistIds = [ART_MAIN, ART_XREF_A, ART_XREF_B, ART_XREF_C, ART_NO_GAC];
      await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id IN ($1, $2, $3)`, [LIB_PRODUCER, LIB_CTA, LIB_NO_GAC]);
      await sql.unsafe(
        `DELETE FROM "${SCHEMA}".artist_crossreference
         WHERE source_artist_id = ANY($1::int[]) OR target_artist_id = ANY($1::int[])`,
        [artistIds]
      );
      await sql.unsafe(`DELETE FROM "${SCHEMA}".genre_artist_crossreference WHERE artist_id = ANY($1::int[])`, [
        artistIds,
      ]);
      await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE id = ANY($1::int[])`, [artistIds]);
      await sql.end();
    }
  });

  test('catalog export carries legacy_release_id + album_artist + alternate_artist_name + cross_reference_names', async () => {
    // Seeding crossref/library does bump library_watermark (library INSERT), but a
    // subsequent bump makes the per-watermark cache rebuild deterministic here.
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET album_title = album_title WHERE id = $1`, [LIB_PRODUCER]);

    const byId = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));
    const row = byId.get(LIB_PRODUCER);
    expect(row).toBeDefined();

    // legacy_release_id: total (BS#1963), a positive integer, matching the DB.
    expect(row.legacy_release_id).toBe(mainLegacyId);
    expect(Number.isInteger(row.legacy_release_id)).toBe(true);
    // id (BS serial) and legacy_release_id are distinct keyspaces.
    expect(row.id).toBe(LIB_PRODUCER);
    expect(row.legacy_release_id).not.toBe(row.id);

    expect(row.album_artist).toBe('Various Artists');
    expect(row.alternate_artist_name).toBe('V/A');

    // An ARRAY on the wire — never the pipe-joined string library.db stores.
    expect(Array.isArray(row.cross_reference_names)).toBe(true);
    expect(row.cross_reference_names.join('')).not.toContain('|');

    // Bidirectional + deduped + self-excluded + ordered by Unicode code point.
    expect(row.cross_reference_names).toEqual(EXPECTED_XREF);
  });

  test('orders cross_reference_names by Unicode code point, not the default collation', async () => {
    // The 'bs1965 Xref Delta' fixture has a lowercase initial. COLLATE "C" sorts
    // it LAST ('b' U+0062 > 'B' U+0042); the database's default en_US.UTF-8
    // collation ignores case at the primary level and would sort it BETWEEN Beta
    // and Gamma. Asserting the C order pins that the query is collation-explicit
    // — without the COLLATE the local default would produce the other order.
    const byId = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));
    const names = byId.get(LIB_PRODUCER).cross_reference_names;

    expect(names).toEqual(['BS1965 Xref Beta', 'BS1965 Xref Gamma', 'bs1965 Xref Delta']);
    // Explicitly NOT the locale-collated order, so a regression to the default
    // fails here with a readable diff rather than passing by coincidence.
    expect(names).not.toEqual(['BS1965 Xref Beta', 'bs1965 Xref Delta', 'BS1965 Xref Gamma']);
  });

  test('excludes the row own artist from cross_reference_names (self-reference guard)', async () => {
    // A self-referencing artist_crossreference row must not produce a self-alias
    // — LML would match the artist against itself.
    const byId = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));
    expect(byId.get(LIB_PRODUCER).cross_reference_names).not.toContain('BS1965 Main Filing Artist');
  });

  test('cross_reference_names is an EMPTY ARRAY for an artist with no cross-references', async () => {
    // Contract: empty array, not null and not absent, so the producer never has
    // to distinguish "no aliases" from "field missing". The CTA-owning row shares
    // ART_MAIN — which HAS cross-references — so use a shape-fixture row whose
    // artist (7001 'Beta') has none seeded.
    const byId = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));
    const noXref = byId.get(7002); // 'Shape Fixture Album Beta 1', artist 7001
    expect(noXref).toBeDefined();
    expect(noXref.cross_reference_names).toEqual([]);
    expect(noXref.cross_reference_names).not.toBeNull();
  });

  test('GET /library/catalog/compilation-tracks returns gzipped NDJSON with freshness + content headers', async () => {
    const res = await auth
      .get('/library/catalog/compilation-tracks')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(collectBuffer);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect((res.headers['vary'] || '').toLowerCase()).toContain('accept-encoding');
    expect(res.headers['last-modified']).toBeTruthy();
    expect((res.headers['content-type'] || '').toLowerCase()).toContain('ndjson');

    const rows = parseRows(res);
    expect(rows.length).toBeGreaterThan(0);
    // Every line carries exactly the 3-column CTA export contract — no id /
    // track_position / library_id leak.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['artist_name', 'legacy_release_id', 'track_title'].sort());
    }
  });

  test('CTA export rows are keyed on legacy_release_id and carry a nullable track_title', async () => {
    const rows = parseRows(await getCta(auth));
    const mine = rows.filter((r) => r.legacy_release_id === ctaLegacyId);

    // The three seeded CTA rows for LIB_CTA, keyed on ITS legacy_release_id.
    expect(mine).toHaveLength(3);
    const byArtist = new Map(mine.map((r) => [r.artist_name, r]));
    expect(byArtist.get('Chuquimamani-Condori').track_title).toBe('Call Your Name');
    expect(byArtist.get('DJ E, Chuquimamani-Condori').track_title).toBe('Wayño');
    // The NULL-track row round-trips as JSON null, not dropped or coerced.
    expect(byArtist.has('Juana Molina')).toBe(true);
    expect(byArtist.get('Juana Molina').track_title).toBeNull();
  });

  test('CTA export is ordered by legacy_release_id', async () => {
    const rows = parseRows(await getCta(auth));
    const ids = rows.map((r) => r.legacy_release_id);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sorted);
  });

  test('honors Accept-Encoding: gzip;q=0 by serving identity NDJSON', async () => {
    const res = await auth
      .get('/library/catalog/compilation-tracks')
      .set('Accept-Encoding', 'gzip;q=0')
      .buffer(true)
      .parse(collectBuffer);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    const rows = parseRows(res);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('CTA export returns 304 when If-Modified-Since matches the current watermark', async () => {
    const first = await getCta(auth);
    expect(first.status).toBe(200);
    const second = await auth
      .get('/library/catalog/compilation-tracks')
      .set('If-Modified-Since', first.headers['last-modified']);
    expect(second.status).toBe(304);
    expect(second.text === '' || second.text === undefined).toBe(true);
  });

  test('CTA export returns 200 after a library row changes (watermark advanced)', async () => {
    const first = await getCta(auth);
    const lastModified = first.headers['last-modified'];
    await sleep(1100);
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET plays = COALESCE(plays, 0) WHERE id = $1`, [LIB_CTA]);
    const after = await auth
      .get('/library/catalog/compilation-tracks')
      .set('If-Modified-Since', lastModified)
      .buffer(true)
      .parse(collectBuffer);
    expect(after.status).toBe(200);
  });

  test('CTA export requires catalog:read auth (401 without a token)', async () => {
    const res = await request.get('/library/catalog/compilation-tracks');
    expect(res.status).toBe(401);
  });

  // ---- Row eligibility: the two exports must apply the SAME predicate --------

  test('drops CTA rows whose owning library row is ineligible for /library/catalog', async () => {
    // LIB_NO_GAC's (artist_id, genre_id) pair has no genre_artist_crossreference
    // entry, so the catalog export's INNER JOIN drops it. An unfiltered CTA export
    // would still ship its track — a library_release_id joining to nothing in the
    // library.db `library` table the sibling endpoint produces, which LML's CTA
    // UNION would surface as a compilation track whose release it cannot resolve.
    const catalogIds = new Set(parseRows(await getCatalog(auth)).map((r) => r.legacy_release_id));
    expect(catalogIds.has(noGacLegacyId)).toBe(false); // precondition: really ineligible
    expect(catalogIds.has(ctaLegacyId)).toBe(true); // control: the eligible sibling IS present

    const ctaRows = parseRows(await getCta(auth));
    expect(ctaRows.map((r) => r.legacy_release_id)).not.toContain(noGacLegacyId);
    expect(ctaRows.map((r) => r.artist_name)).not.toContain('BS1965 Orphan Track Artist');
  });

  test('every CTA legacy_release_id resolves to a row in the catalog export', async () => {
    // The invariant the eligibility predicate exists to hold, asserted over the
    // WHOLE body rather than just the seeded fixture: the producer builds
    // library.db's compilation_track_artist FK against library.db's library table,
    // so a CTA key with no library row is a broken join in the artifact.
    const catalogIds = new Set(parseRows(await getCatalog(auth)).map((r) => r.legacy_release_id));
    const orphans = [...new Set(parseRows(await getCta(auth)).map((r) => r.legacy_release_id))].filter(
      (id) => !catalogIds.has(id)
    );
    expect(orphans).toEqual([]);
  });

  // ---- Watermark coverage (migration 0138) ----------------------------------

  test('an artist_crossreference write advances the watermark and republishes the catalog', async () => {
    // Without the 0138 trigger this failure is silent and unbounded, not a lag:
    // artist_crossreference is not one of the seven tables 0104/0105 cover, so a
    // new alias would never advance the watermark, the per-watermark gzip cache
    // would never rebuild, and the producer would 304 forever against a body that
    // will never contain it.
    const before = await getCatalog(auth);
    const lastModified = before.headers['last-modified'];
    expect(parseRows(before).find((r) => r.id === LIB_PRODUCER).cross_reference_names).toEqual(EXPECTED_XREF);

    await sleep(1100); // Last-Modified has 1-second resolution
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".artist_crossreference
       WHERE source_artist_id = $1 AND target_artist_id = $2`,
      [ART_MAIN, ART_XREF_C]
    );

    const after = await auth
      .get('/library/catalog')
      .set('If-Modified-Since', lastModified)
      .buffer(true)
      .parse(collectBuffer);
    expect(after.status).toBe(200); // NOT 304 — the crossref write moved the watermark
    expect(parseRows(after).find((r) => r.id === LIB_PRODUCER).cross_reference_names).toEqual([
      XREF_A_NAME,
      XREF_B_NAME,
    ]);

    // Restore for the fixture-parity test, and confirm the re-add republishes too.
    await sleep(1100);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_crossreference (source_artist_id, target_artist_id, comment)
       VALUES ($1, $2, 'collation-probe')
       ON CONFLICT (source_artist_id, target_artist_id) DO NOTHING`,
      [ART_MAIN, ART_XREF_C]
    );
    expect(parseRows(await getCatalog(auth)).find((r) => r.id === LIB_PRODUCER).cross_reference_names).toEqual(
      EXPECTED_XREF
    );
  });

  test('a compilation_track_artist write advances the watermark and republishes the CTA export', async () => {
    // The sharp case. The intuitive "the CTA rows ride the library add" reasoning
    // is backwards: the CTA POST always FOLLOWS the library add, so the cached
    // body for the library-add watermark never contains the tracks. Without the
    // 0138 trigger this endpoint 304s until some unrelated write moves the
    // watermark — and post-tubafrenzy-turndown there is no daily library sync left
    // to eventually supply one.
    const before = await getCta(auth);
    const lastModified = before.headers['last-modified'];
    const countBefore = parseRows(before).filter((r) => r.legacy_release_id === ctaLegacyId).length;

    await sleep(1100);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title, track_position)
       VALUES ($1, 'BS1965 Late Added Track Artist', 'Added After The Library Row', 'C1')`,
      [LIB_CTA]
    );

    const after = await auth
      .get('/library/catalog/compilation-tracks')
      .set('If-Modified-Since', lastModified)
      .buffer(true)
      .parse(collectBuffer);
    expect(after.status).toBe(200); // NOT 304 — the CTA write moved the watermark
    const mine = parseRows(after).filter((r) => r.legacy_release_id === ctaLegacyId);
    expect(mine).toHaveLength(countBefore + 1);
    expect(mine.map((r) => r.artist_name)).toContain('BS1965 Late Added Track Artist');

    // Reap so the fixture-parity test still sees exactly its three seeded rows.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE library_id = $1 AND artist_name = $2`, [
      LIB_CTA,
      'BS1965 Late Added Track Artist',
    ]);
  });

  // The acceptance-criterion parity check: for one known release, the exported
  // library row + CTA rows match the library.db shape the legacy MySQL TSV
  // produces (modulo the documented `label` omission), so the producer can build
  // byte-parity library.db.
  test('fixture-level parity: a known release maps to the library.db row + CTA shape', async () => {
    const libById = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));
    const lib = libById.get(LIB_PRODUCER);
    expect(lib).toBeDefined();

    // The 12-column library.db `library` row the producer builds via
    // `legacy_release_id AS id` (label omitted -> always NULL in library.db).
    const libraryDbRow = {
      id: lib.legacy_release_id,
      title: lib.album_title,
      artist: lib.artist_name,
      call_letters: lib.code_letters,
      artist_call_number: lib.code_artist_number,
      release_call_number: lib.code_number,
      genre: lib.genre_name,
      format: lib.format_name,
      alternate_artist_name: lib.alternate_artist_name,
      album_artist: lib.album_artist,
      label: null, // library.db always-NULL by design
      // The producer owns the ' | ' join — the wire ships an array, SQLite stores
      // the joined string. This line IS that join, so the parity check exercises
      // the same transformation discogs-etl#351 performs.
      cross_reference_names: lib.cross_reference_names.join(' | '),
    };
    expect(libraryDbRow).toEqual({
      id: mainLegacyId,
      title: 'BS1965 Producer Probe',
      artist: 'BS1965 Main Filing Artist',
      call_letters: 'ZA',
      artist_call_number: 970,
      release_call_number: 71,
      genre: 'Rock',
      format: 'cd',
      alternate_artist_name: 'V/A',
      album_artist: 'Various Artists',
      label: null,
      cross_reference_names: EXPECTED_XREF.join(' | '),
    });

    // The 3-column library.db `compilation_track_artist` rows for a known release,
    // keyed by the SAME legacy_release_id the library row exports as its id.
    const cta = parseRows(await getCta(auth)).filter((r) => r.legacy_release_id === ctaLegacyId);
    const ctaDbRows = cta
      .map((r) => ({
        library_release_id: r.legacy_release_id,
        artist_name: r.artist_name,
        track_title: r.track_title,
      }))
      .sort((a, b) => a.artist_name.localeCompare(b.artist_name));
    expect(ctaDbRows).toEqual(
      [
        { library_release_id: ctaLegacyId, artist_name: 'Chuquimamani-Condori', track_title: 'Call Your Name' },
        { library_release_id: ctaLegacyId, artist_name: 'DJ E, Chuquimamani-Condori', track_title: 'Wayño' },
        { library_release_id: ctaLegacyId, artist_name: 'Juana Molina', track_title: null },
      ].sort((a, b) => a.artist_name.localeCompare(b.artist_name))
    );
  });
});
