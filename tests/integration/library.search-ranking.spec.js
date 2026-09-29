const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectArray } = require('../utils/test_helpers');

/**
 * Catalog Search Ranking E2E Tests (Epic A.6)
 *
 * Verifies the new tsvector + plays Both-mode path and the trigram fallback
 * land at the HTTP boundary. The unit suite at
 * tests/unit/services/library.service.test.ts asserts the routing logic;
 * these tests assert that the seed fixture, schema, and service compose so
 * the published `/library` endpoint returns the right rows.
 *
 * Both-mode is triggered by sending the same string as `artist_name` and
 * `album_title` (the dj-site default). That is the path the new ranker
 * exists for.
 */

describe('GET /library — ranking quality (Epic A)', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('Both-mode multi-word query AND-restricts to the matching album', async () => {
    // The seed has two Stereolab albums. `stereolab transient` should match
    // only the Transient-Random-Noise-Bursts row; the other Stereolab album
    // (Mars Audiac Quintet) lacks the second token and must drop out.
    const q = 'stereolab transient';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].artist_name.toLowerCase()).toContain('stereolab');
    expect(res.body[0].album_title.toLowerCase()).toContain('transient');
    // AND-semantics: Mars Audiac Quintet (no "transient" token) should not appear.
    for (const row of res.body) {
      expect(row.album_title.toLowerCase()).not.toContain('mars audiac');
    }
  });

  test('Both-mode falls back to trigram for typo-laden queries', async () => {
    // `sterolab` (one missing letter) is a trigram-distance-1 match against
    // `stereolab` and produces no tsvector hit (distinct lexeme). The
    // service must run the fallback and still return Stereolab rows.
    const q = 'sterolab';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.some((row) => row.artist_name.toLowerCase().includes('stereolab'))).toBe(true);
  });

  test('Both-mode returns empty for pure-punctuation queries', async () => {
    const q = '!!!';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBe(0);
  });

  test('result rows expose the denormalized artist_name (no view dependency)', async () => {
    // The new path reads `library.artist_name` directly. If the denorm
    // column is unpopulated for seed rows, ranking degrades to album_title
    // only — this assertion guards against that regression.
    const q = 'stereolab';
    const res = await auth.get('/library').query({ artist_name: q, album_title: q }).expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(typeof row.artist_name).toBe('string');
      expect(row.artist_name.length).toBeGreaterThan(0);
    }
  });
});

/**
 * BS#2725 — match-tier ranking replaces `ts_rank * (1 + ln(plays + 1))`.
 *
 * Postgres-backed (direct SQL seeds probe albums + flowsheet plays and
 * refreshes the `album_plays` MV; supertest drives the HTTP surface) — same
 * harness as library-query-sort-plays.spec.js.
 *
 * Probe rows live in the reserved 7000-range on ids the shape fixture leaves
 * free (7080-7086), reusing fixture artist 7000 ('XA'), genre 11 ('Rock'),
 * format 1 ('cd') so every joined display field exists.
 */
describe('GET /library — match-tier ranking (BS#2725)', () => {
  const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const ART = 7000;
  const GEN = 11;
  const FMT = 1;

  let auth;
  let sql;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
      max: 2,
    });
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  /** Insert one probe album, optionally give it `plays` flowsheet track rows, and refresh the MV. */
  async function seedProbe({ id, codeNumber, artistName, albumTitle, plays = 0 }) {
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, ART, GEN, FMT, albumTitle, codeNumber, artistName]
    );
    for (let i = 0; i < plays; i++) {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
         VALUES ($1, 'track', $2, $3, $4, $5)`,
        [id, 9300 + id + i, artistName, albumTitle, `probe track ${i}`]
      );
    }
    await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
  }

  async function teardownProbes(ids) {
    // flowsheet.album_id is ON DELETE SET NULL — reap the play rows by
    // album_id BEFORE deleting the library row (album_id goes NULL after).
    for (const id of ids) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE album_id = $1`, [id]);
    }
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1)`, [ids]);
    await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
  }

  test('a higher-relevance match with few plays outranks a lower-relevance match with many plays', async () => {
    // Both rows match the token once, so the multiplicative ranker's old
    // `ts_rank * (1 + ln(plays + 1))` product is decided almost entirely by
    // plays: an artist-name (weight A) hit with 0 plays scores ts_rank * 1,
    // while an album-title (weight B) hit with 40 plays scores its (lower)
    // ts_rank * (1 + ln(41)) ~= ts_rank * 4.7 — enough to flip the order.
    // Tiering removes the multiplier: within the same tier the ranker falls
    // back to bare ts_rank, so the artist-name hit must sort first regardless
    // of plays.
    const token = 'zzrankprobe2725a';
    const HIGH_RELEVANCE = 7080; // artist_name match (weight A), 0 plays
    const LOW_RELEVANCE = 7082; // album_title match (weight B), many plays

    await seedProbe({ id: HIGH_RELEVANCE, codeNumber: 80, artistName: token, albumTitle: 'Probe Album Alpha' });
    await seedProbe({
      id: LOW_RELEVANCE,
      codeNumber: 82,
      artistName: 'Probe Artist Beta',
      albumTitle: token,
      plays: 40,
    });

    try {
      const res = await auth.get('/library').query({ artist_name: token, album_title: token, n: 10 }).expect(200);

      expectArray(res);
      const ids = res.body.map((row) => row.id);
      expect(ids).toEqual([HIGH_RELEVANCE, LOW_RELEVANCE]);
    } finally {
      await teardownProbes([HIGH_RELEVANCE, LOW_RELEVANCE]);
    }
  });

  test('ties within a tier still order by plays', async () => {
    // Identical artist_name content on both rows -> identical ts_rank ->
    // identical match_tier. The only remaining tiebreak is album_plays_count.
    const token = 'zzrankprobe2725b';
    const FEW_PLAYS = 7084;
    const MANY_PLAYS = 7086;

    await seedProbe({ id: FEW_PLAYS, codeNumber: 84, artistName: token, albumTitle: 'Probe Album Gamma', plays: 1 });
    await seedProbe({
      id: MANY_PLAYS,
      codeNumber: 86,
      artistName: token,
      albumTitle: 'Probe Album Delta',
      plays: 10,
    });

    try {
      const res = await auth.get('/library').query({ artist_name: token, album_title: token, n: 10 }).expect(200);

      expectArray(res);
      const ids = res.body.map((row) => row.id);
      expect(ids).toEqual([MANY_PLAYS, FEW_PLAYS]);
    } finally {
      await teardownProbes([FEW_PLAYS, MANY_PLAYS]);
    }
  });

  test('the ranking helper columns never reach the response body', async () => {
    const token = 'zzrankprobe2725c';
    const PROBE = 7081;

    await seedProbe({ id: PROBE, codeNumber: 81, artistName: token, albumTitle: 'Probe Album Epsilon', plays: 3 });

    try {
      const res = await auth.get('/library').query({ artist_name: token, album_title: token, n: 10 }).expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
      for (const row of res.body) {
        expect(row).not.toHaveProperty('match_tier');
        expect(row).not.toHaveProperty('exact_score');
        expect(row).not.toHaveProperty('album_score');
        expect(row).not.toHaveProperty('album_plays_count');
      }
    } finally {
      await teardownProbes([PROBE]);
    }
  });
});
