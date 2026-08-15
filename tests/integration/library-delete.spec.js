/**
 * Integration tests for DELETE /library/:id (BS#2112).
 *
 * Covers the D10 dependent-row policy end to end against the real DB:
 *   - happy-path hard delete (204), and the row is really gone (a second
 *     delete 404s) rather than soft-tombstoned.
 *   - the library_watermark advance so a client holding a pre-delete
 *     Last-Modified re-pulls the catalog instead of 304-ing stale.
 *   - the flowsheet-referenced 409 refusal: never silently blank play
 *     history via the `flowsheet.album_id` set-null FK — the release and
 *     its plays both survive the refused request.
 *   - the four blocking FKs (`bins`, `library_identity`,
 *     `library_identity_source`, `artist_library_crossreference`) resolved
 *     inside the same transaction as the delete, rather than the DELETE
 *     raising a raw FK-violation 500. `artist_library_crossreference` is
 *     the surprise fourth: schema.ts declares its FK `onDelete: 'cascade'`,
 *     but the live constraint (migration 0022) was created `ON DELETE no
 *     action` and never migrated to match — verified against
 *     `pg_constraint.confdeltype`, not just the Drizzle model.
 *   - the real cascading dependents (`rotation`, `album_metadata`,
 *     `album_critic_reviews`, `reviews`, `compilation_track_artist`) left
 *     to their own `onDelete: 'cascade'` FK, plus
 *     `album_review_submissions`'s `onDelete: 'set null'` divergence (the
 *     row survives, unlinked).
 *   - 404 on an unknown id.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // shape-fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DELETE /library/:id (BS#2112)', () => {
  let auth;
  let sql;
  const uniq = Date.now();

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  const createAlbum = async (title) => {
    const res = await auth
      .post('/library')
      .send({
        album_title: title,
        artist_name: 'Built to Spill',
        label: `BS#2112 Delete Test ${uniq}`,
        genre_id: GEN,
        format_id: FMT,
      })
      .expect(201);
    return res.body;
  };

  test('hard-deletes an unreferenced release, returns 204, and advances the catalog watermark', async () => {
    const album = await createAlbum(`BS#2112 Happy Path ${uniq}`);

    const before = await auth.get('/library/catalog').expect(200);
    const lastModified = before.headers['last-modified'];
    // Ensure the next watermark lands in a strictly later whole second than
    // the captured Last-Modified (HTTP Date precision is whole seconds) —
    // same guard `library-catalog-export.spec.js` uses.
    await sleep(1100);

    await auth.delete(`/library/${album.id}`).expect(204);

    // The row is really gone (hard delete, not a soft-delete tombstone) — a
    // second delete has nothing left to find.
    await auth.delete(`/library/${album.id}`).expect(404);

    // library_watermark advanced: a client polling with the pre-delete
    // Last-Modified must re-pull the catalog rather than 304 a stale clone.
    const after = await auth.get('/library/catalog').set('If-Modified-Since', lastModified);
    expect(after.status).toBe(200);
  });

  test('returns 404 for an unknown id', async () => {
    await auth.delete('/library/99999999').expect(404);
  });

  test('refuses with 409 naming the play count when the release carries flowsheet plays (D10)', async () => {
    const album = await createAlbum(`BS#2112 Flowsheet Refusal ${uniq}`);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9500, 'Built to Spill', $2, 'probe track one'),
              ($1, 'track', 9501, 'Built to Spill', $2, 'probe track two')`,
      [album.id, `BS#2112 Flowsheet Refusal ${uniq}`]
    );

    const res = await auth.delete(`/library/${album.id}`).expect(409);
    expect(res.body.reason).toBe('flowsheet_references');
    expect(res.body.play_count).toBe(2);
    expect(res.body.message).toContain('2');

    // Refused, not partially applied: the release and its plays both survive.
    const info = await auth.get('/library/info').query({ album_id: album.id }).expect(200);
    expect(info.body.id).toBe(album.id);
    const plays = await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".flowsheet WHERE album_id = $1`, [
      album.id,
    ]);
    expect(plays[0].n).toBe(2);
  });

  test('resolves bins, library_identity, library_identity_source, and artist_library_crossreference inside the transaction instead of raising an FK violation', async () => {
    const album = await createAlbum(`BS#2112 Blocking FK ${uniq}`);

    await sql.unsafe(`INSERT INTO "${SCHEMA}".bins (dj_id, album_id, track_title) VALUES ($1, $2, 'probe bin pick')`, [
      global.primary_dj_id,
      album.id,
    ]);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library_identity (library_id, last_verified_at, method, confidence)
       VALUES ($1, now(), 'test_probe', 0.9)`,
      [album.id]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library_identity_source (library_id, source, external_id, method, confidence, last_verified_at)
       VALUES ($1, 'discogs', 'probe-external-id', 'test_probe', 0.9, now())`,
      [album.id]
    );
    // `artist_library_crossreference`'s live FK is `ON DELETE no action`
    // (migration 0022) despite schema.ts's `onDelete: 'cascade'` annotation
    // — a genuine drift this spec caught. It must be resolved explicitly
    // like the other three, not left to the FK.
    await sql.unsafe(`INSERT INTO "${SCHEMA}".artist_library_crossreference (artist_id, library_id) VALUES ($1, $2)`, [
      ART,
      album.id,
    ]);

    await auth.delete(`/library/${album.id}`).expect(204);

    const counts = await sql.unsafe(
      `SELECT
         (SELECT count(*)::int FROM "${SCHEMA}".bins WHERE album_id = $1) AS bins,
         (SELECT count(*)::int FROM "${SCHEMA}".library_identity WHERE library_id = $1) AS library_identity,
         (SELECT count(*)::int FROM "${SCHEMA}".library_identity_source WHERE library_id = $1) AS library_identity_source,
         (SELECT count(*)::int FROM "${SCHEMA}".artist_library_crossreference WHERE library_id = $1) AS artist_library_crossreference
      `,
      [album.id]
    );
    expect(counts[0]).toEqual({
      bins: 0,
      library_identity: 0,
      library_identity_source: 0,
      artist_library_crossreference: 0,
    });
  });

  test('leaves the real cascading dependents to their own FK', async () => {
    const album = await createAlbum(`BS#2112 Cascade ${uniq}`);
    const sourceKey = `probe-source-key-${album.id}`;

    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H')`, [album.id]);
    await sql.unsafe(`INSERT INTO "${SCHEMA}".album_metadata (album_id) VALUES ($1)`, [album.id]);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_critic_reviews (album_id, source, source_url, snippet)
       VALUES ($1, 'Probe Zine', 'https://example.com/probe', 'a probe snippet')`,
      [album.id]
    );
    await sql.unsafe(`INSERT INTO "${SCHEMA}".reviews (album_id) VALUES ($1)`, [album.id]);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name) VALUES ($1, 'Probe CTA Artist')`,
      [album.id]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_review_submissions (source, source_key, norm_artist, norm_album, album_id)
       VALUES ('google_form', $1, 'probe artist', 'probe album', $2)`,
      [sourceKey, album.id]
    );

    await auth.delete(`/library/${album.id}`).expect(204);

    const counts = await sql.unsafe(
      `SELECT
         (SELECT count(*)::int FROM "${SCHEMA}".rotation WHERE album_id = $1) AS rotation,
         (SELECT count(*)::int FROM "${SCHEMA}".album_metadata WHERE album_id = $1) AS album_metadata,
         (SELECT count(*)::int FROM "${SCHEMA}".album_critic_reviews WHERE album_id = $1) AS album_critic_reviews,
         (SELECT count(*)::int FROM "${SCHEMA}".reviews WHERE album_id = $1) AS reviews,
         (SELECT count(*)::int FROM "${SCHEMA}".compilation_track_artist WHERE library_id = $1) AS compilation_track_artist
       `,
      [album.id]
    );
    expect(counts[0]).toEqual({
      rotation: 0,
      album_metadata: 0,
      album_critic_reviews: 0,
      reviews: 0,
      compilation_track_artist: 0,
    });

    // album_review_submissions is `onDelete: 'set null'` — the row survives,
    // unlinked, not deleted (BS#2112's dependent-row map).
    const submission = await sql.unsafe(
      `SELECT album_id FROM "${SCHEMA}".album_review_submissions WHERE source_key = $1`,
      [sourceKey]
    );
    expect(submission[0].album_id).toBeNull();
  });
});
