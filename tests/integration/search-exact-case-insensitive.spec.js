/**
 * BS#2398 — a quoted search term must match the whole column value, case-
 * insensitively, on both search surfaces.
 *
 * Quoting is meant to narrow the match from "contains" to "is". It was also
 * making it byte-exact, because the `exact` branch of each builder compiled
 * Postgres `=` while every unquoted sibling compiled ILIKE. The report that
 * opened the ticket was `"cat power"` returning nothing where `"Cat Power"`
 * returned the artist; a DJ hit the same thing with `"hi scores"` versus
 * `"Hi Scores"` (Boards of Canada, Skam). A silent empty page gave them no way
 * to tell whether the release was missing or their shift key was.
 *
 * The unit suites (`tests/unit/services/search.service.exactMatch.test.ts`,
 * `library-search.exactMatch.test.ts`) pin the compiled operator at all five
 * call sites. This spec is here for the claim those cannot make — that the two
 * casings return *the same rows* out of real Postgres, under real collation and
 * a real ESCAPE clause.
 *
 * Deliberately not covered: the `dj:` prefix, the third flowsheet site. Its
 * column carries no index (migration 0083 dropped the trigram one and nothing
 * replaced it), so every dj-name predicate — quoted or not, before or after
 * this change — is a full seq scan of the flowsheet heap that 500s on the 5s
 * statement_timeout in production. Asserting anything about its result set here
 * would pass against CI's near-empty table while telling a reader nothing
 * about the surface they actually use. BS#2400 owns that.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Mixed-case on purpose, and unique to this spec: every seeded value carries it
// so the quoted whole-value probes below cannot collide with a row another
// spec inserted in a parallel worker.
const MARKER = 'Bs2398';

const ALBUM = `${MARKER} Moon Pix`;
const ARTIST = `${MARKER} Cat Power`;
const TRACK = `${MARKER} Metal Heart`;
const LABEL = `${MARKER} Matador`;

// `%` and `_` are ILIKE metacharacters. Under `=` they were literal for free,
// because `=` has no pattern language; under ILIKE they are literal only
// because the builder escapes them. LITERAL_ALBUM is what a correct
// implementation matches, WILDCARD_DECOY is what a wildcard reading of the
// same string would ALSO match — `%` absorbing "ab" and `_` taking "c".
const LITERAL_ALBUM = `${MARKER} 100%_Pure`;
const WILDCARD_DECOY = `${MARKER} 100abcPure`;

const ids = (res) => res.body.results.map((row) => row.id).sort((a, b) => a - b);

describe('GET /flowsheet/search: quoted terms are case-insensitive (BS#2398)', () => {
  let sql;
  let insertedIds = [];
  let literalAlbumId;

  beforeAll(async () => {
    sql = getTestDb();

    // Explicit add_time well in the past so this batch cannot disturb another
    // spec's recency assertions.
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (entry_type, artist_name, track_title, album_title, record_label, play_order, add_time)
       VALUES
         ('track', $1, $2, $3, $4, 1, TIMESTAMPTZ '2019-04-01 12:00:00+00'),
         ('track', $1, $2, $5, $4, 2, TIMESTAMPTZ '2019-04-01 12:01:00+00'),
         ('track', $1, $2, $6, $4, 3, TIMESTAMPTZ '2019-04-01 12:02:00+00')
       RETURNING id, album_title`,
      [ARTIST, TRACK, ALBUM, LABEL, LITERAL_ALBUM, WILDCARD_DECOY]
    );

    insertedIds = rows.map((r) => r.id);
    literalAlbumId = rows.find((r) => r.album_title === LITERAL_ALBUM).id;
    expect(insertedIds).toHaveLength(3);
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedIds]);
    }
  });

  test.each([
    ['all-field', (v) => `"${v}"`],
    ['album:', (v) => `album:"${v}"`],
  ])('%s quoted term returns the same rows in either casing', async (_label, quote) => {
    const mixed = await request
      .get('/flowsheet/search')
      .query({ q: quote(ALBUM), limit: 50 })
      .expect(200);
    const lower = await request
      .get('/flowsheet/search')
      .query({ q: quote(ALBUM.toLowerCase()), limit: 50 })
      .expect(200);
    const upper = await request
      .get('/flowsheet/search')
      .query({ q: quote(ALBUM.toUpperCase()), limit: 50 })
      .expect(200);

    // Non-empty first: three identical empty pages would satisfy the equality
    // below while proving that quoting matches nothing at all.
    expect(ids(mixed)).toHaveLength(1);
    expect(ids(lower)).toEqual(ids(mixed));
    expect(ids(upper)).toEqual(ids(mixed));
  });

  test('a quoted term still has to match the whole value', async () => {
    // A prefix of the seeded title. Quoting narrows the match; only the
    // case-sensitivity was wrong, so this must stay empty.
    const res = await request
      .get('/flowsheet/search')
      .query({ q: `album:"${MARKER} Moon"`, limit: 50 })
      .expect(200);

    expect(res.body.results).toEqual([]);
  });

  test.each([
    ['as typed', LITERAL_ALBUM],
    ['lower-cased', LITERAL_ALBUM.toLowerCase()],
  ])('reads %% and _ in a quoted value literally (%s)', async (_label, value) => {
    const res = await request
      .get('/flowsheet/search')
      .query({ q: `album:"${value}"`, limit: 50 })
      .expect(200);

    // Exactly the escaped row: the decoy is in the table and would come back
    // too if the pattern were interpreted rather than escaped.
    expect(ids(res)).toEqual([literalAlbumId]);
  });

  test('a quoted term matches any of the four searched columns', async () => {
    // The all-field branch ORs over artist / track / album / label. Only the
    // label probe can show the fourth arm is wired, since the other three
    // share this batch's rows.
    const res = await request
      .get('/flowsheet/search')
      .query({ q: `"${LABEL.toLowerCase()}"`, limit: 50 })
      .expect(200);

    expect(ids(res)).toEqual([...insertedIds].sort((a, b) => a - b));
  });
});

describe('GET /library/query: quoted terms are case-insensitive (BS#2398)', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  // Stereolab and its two albums come from the seed (dev_env/seed_db.sql), so
  // this half adds no rows of its own.
  test.each([
    ['artist:', 'artist', 'Stereolab'],
    ['album:', 'album', 'Mars Audiac Quintet'],
  ])('%s quoted term returns the same rows in either casing', async (_label, field, value) => {
    const mixed = await auth
      .get('/library/query')
      .query({ q: `${field}:"${value}"`, limit: 50 })
      .expect(200);
    const lower = await auth
      .get('/library/query')
      .query({ q: `${field}:"${value.toLowerCase()}"`, limit: 50 })
      .expect(200);
    const upper = await auth
      .get('/library/query')
      .query({ q: `${field}:"${value.toUpperCase()}"`, limit: 50 })
      .expect(200);

    expect(ids(mixed).length).toBeGreaterThan(0);
    expect(ids(lower)).toEqual(ids(mixed));
    expect(ids(upper)).toEqual(ids(mixed));
  });

  test('an all-field quoted term returns the same rows in either casing', async () => {
    const mixed = await auth.get('/library/query').query({ q: '"Stereolab"', limit: 50 }).expect(200);
    const lower = await auth.get('/library/query').query({ q: '"stereolab"', limit: 50 }).expect(200);

    expect(ids(mixed).length).toBeGreaterThan(0);
    expect(ids(lower)).toEqual(ids(mixed));
  });

  test('a quoted term still has to match the whole value', async () => {
    const res = await auth.get('/library/query').query({ q: 'artist:"Stereo"', limit: 50 }).expect(200);

    expect(res.body.results).toEqual([]);
  });

  test('reads % in a quoted value literally', async () => {
    // Would match Stereolab if `%` were a wildcard rather than an escaped
    // literal.
    const res = await auth.get('/library/query').query({ q: 'artist:"Stereola%"', limit: 50 }).expect(200);

    expect(res.body.results).toEqual([]);
  });
});
