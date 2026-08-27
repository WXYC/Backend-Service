/**
 * `GET /album-reviews` (ADR 0011 / the dj-reviews-internal-surface plan).
 *
 * Postgres-backed: direct SQL seeds a library album (with its FK
 * scaffolding) and a deterministic set of `album_review_submissions` rows
 * keyed by an `itest-ar:` source_key prefix, so cleanup is a prefix DELETE
 * and nothing leaks across runs — the same idiom as concerts.spec.js.
 *
 * THIS TIER CANNOT PIN THE ROLE GATE, and does not try to. The CI containers
 * run `AUTH_BYPASS=true`, under which `requirePermissions` decodes the token,
 * checks only `banned`, and returns `next()` — the permission block is
 * unreachable, so `requirePermissions({ album_reviews: ['read'] })` and
 * `requirePermissions({})` behave identically here. The gate lives in
 * `tests/unit/routes/album-reviews-permissions.route.test.ts` (CI) and
 * `tests/e2e/album-reviews-pipeline.test.ts` (the only tier with
 * AUTH_BYPASS=false). What this file pins is row/consent/PII behavior against
 * real SQL, which is auth-agnostic.
 *
 * Pins the load-bearing server contract:
 *   - the CONSENT POSTURE: rows of all three `social_consent` states
 *     (true / false / NULL) all surface, because the consent question asked
 *     only about outside publication and this is the internal surface. The
 *     public attach's `social_consent = true` gate is a different surface
 *     and is pinned separately by wxyc-reviews-metadata.spec.js;
 *   - the `review IS NOT NULL` floor: a bodyless submission is not a review
 *     and never appears, on any filter;
 *   - PII exclusion ON THE WIRE: response objects carry no `reviewer_raw`
 *     or `social_consent_raw` keys (nor any internal ETL column) even
 *     though the seeded rows populate both — the projection barrier;
 *   - ordering by `submitted_at` DESC NULLS LAST (the timestamp-less row
 *     sorts last, not first);
 *   - `album_id` exact filter and `artist` normalized filter
 *     (case-insensitive, leading-"The"-insensitive);
 *   - page/limit pagination with PaginationInfo;
 *   - param-validation 400s.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_KEY_PREFIX = 'itest-ar:';
const ARTIST_NAME = 'Juana Molina';

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

/** ISO instant for now - offsetDays. Ordering is on the instant itself. */
function isoInstant(offsetDays) {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString();
}

const NEWEST = isoInstant(10); // Juana review 2 (multi-review pair, newest)
const MIDDLE = isoInstant(50); // Jessica Pratt review
const OLDEST = isoInstant(100); // Juana review 1 (fully populated row)

describe('GET /album-reviews (ADR 0011)', () => {
  let auth;
  let sql;
  let libraryId;
  const seededIds = {};

  // postgres.js object-insert (`${sql(row)}`), the idiom
  // `concerts-genre-enrichment.spec.js` uses. This was a 19-key `defaults`
  // object + a 20-column INSERT list + a positional `$1..$19` array that had
  // to stay index-aligned with it — three representations of one row shape,
  // whose failure mode is silent: inserting a column mid-list without shifting
  // the values array writes `fcc_violations` text into `review_purpose` and
  // every assertion that doesn't read those two still passes. The `defaults`
  // object is gone because every column it nulled is nullable in the DDL
  // (schema.ts), so an omitted key and an explicit null produce the same row.
  const seedSubmission = async (key, overrides) => {
    const row = { source: 'google_form', source_key: SOURCE_KEY_PREFIX + key, ...overrides };
    const [inserted] = await sql`
      INSERT INTO ${sql(SCHEMA)}.album_review_submissions ${sql(row)} RETURNING id`;
    seededIds[key] = inserted.id;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".album_review_submissions WHERE source_key LIKE $1`, [
      `${SOURCE_KEY_PREFIX}%`,
    ]);
    // Library rows created by a previous (possibly failed) run: owned via
    // the ZZ-coded probe artist, so the sweep can never touch fixture data.
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".library
        WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name = $1 AND code_letters = 'ZZ')`,
      [ARTIST_NAME]
    );
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1 AND code_letters = 'ZZ'`, [ARTIST_NAME]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup(); // idempotent across re-runs (shared schema, --runInBand)

    // FK scaffolding for the album_id filter: artists → library. genre_id /
    // format_id are NOT NULL FKs; the seed DB fixture guarantees at least
    // one row in each (dev_env/seed_db.sql).
    const [genre] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".genres ORDER BY id LIMIT 1`);
    const [format] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [ARTIST_NAME]
    );
    const [lib] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, 'DOGA', 9101, $4) RETURNING id`,
      [artist.id, genre.id, format.id, ARTIST_NAME]
    );
    libraryId = lib.id;

    // Fully populated linked review — the wire-shape row. reviewer_raw and
    // social_consent_raw are deliberately set: the PII assertions below
    // prove they never reach the wire.
    await seedSubmission('juana-1', {
      album_id: libraryId,
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      record_label: 'Sonamos',
      artist_blurb: 'Argentine electronic-folk auteur.',
      review: 'Hypnotic layered loops; a late-night staple.',
      recommended_tracks: '1, 3 (!!!!), 5',
      buzzwords: 'hypnotic, electronic, folk',
      fcc_violations: 'None',
      review_purpose: 'Rotation',
      reviewer_raw: 'A Real Name, 3/15/21',
      social_consent_raw: 'Yes, but remove my name',
      social_consent: true,
      released_within_six_months: true,
      rotated: true,
      submitted_at: OLDEST,
      norm_artist: 'juana molina',
      norm_album: 'doga',
    });

    // Second review of the SAME album (the multi-review invariant that
    // separates this archive from ADR 0006's one-per-album reviews), and the
    // `social_consent = false` arm: this reviewer declined SOCIAL-MEDIA
    // publication. It must still appear on the internal surface — that is the
    // decision this endpoint encodes.
    await seedSubmission('juana-2', {
      album_id: libraryId,
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      review: 'Still hypnotic on the hundredth listen.',
      social_consent: false,
      social_consent_raw: 'No',
      reviewer_raw: 'A Third Real Name, 6/1/24',
      submitted_at: NEWEST,
      norm_artist: 'juana molina',
      norm_album: 'doga',
    });

    // Bodyless submission on the SAME album — the `review IS NOT NULL` floor.
    // Deliberately given the NEWEST timestamp so a missing predicate would
    // surface it at the TOP of the album_id window, not somewhere ignorable.
    await seedSubmission('juana-bodyless', {
      album_id: libraryId,
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      review: null,
      submitted_at: NEWEST,
      norm_artist: 'juana molina',
      norm_album: 'doga',
    });

    // Unlinked review (album_id NULL — the ~unmatched cohort).
    await seedSubmission('pratt', {
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      review: 'Whispered folk miniatures. Timeless.',
      submitted_at: MIDDLE,
      norm_artist: 'jessica pratt',
      norm_album: 'on your own love again',
    });

    // Timestamp-less review (the nots: fallback cohort) — must sort LAST
    // under submitted_at DESC NULLS LAST, and is the artist-filter target.
    await seedSubmission('stereolab', {
      artist_name: 'Stereolab',
      album_title: 'Dots and Loops',
      review: 'Motorik lounge-pop; side two is all peaks.',
      submitted_at: null,
      norm_artist: 'stereolab',
      norm_album: 'dots and loops',
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  /** Reviews from a response body that belong to this spec's seed. */
  const seeded = (body) => {
    const ids = new Set(Object.values(seededIds));
    return body.album_reviews.filter((r) => ids.has(r.id));
  };

  describe('auth', () => {
    // The only auth fact this tier can establish: AUTH_BYPASS still requires
    // the header. It says nothing about WHICH roles are admitted — see the
    // file header.
    it('returns 401 without an Authorization header', async () => {
      const res = await request.get('/album-reviews');
      expect(res.status).toBe(401);
    });
  });

  describe('default listing', () => {
    // The seed is immutable after beforeAll and nothing in this describe
    // mutates rows, so the unfiltered listing is fetched once rather than
    // re-requested by each case — four identical HTTP round trips, eight
    // Postgres queries, on a suite that runs in CI on every push.
    let listing;

    beforeAll(async () => {
      listing = await auth.get('/album-reviews').query({ limit: 100 });
      expect(listing.status).toBe(200);
    });

    it('orders by submitted_at DESC with the timestamp-less row LAST (NULLS LAST)', async () => {
      const rows = seeded(listing.body);
      expect(rows.map((r) => r.id)).toEqual([
        seededIds['juana-2'], // newest instant
        seededIds['pratt'],
        seededIds['juana-1'], // oldest instant
        seededIds['stereolab'], // null submitted_at — last, not first
      ]);
      expect(rows[3].submitted_at).toBeNull();
      // juana-bodyless shares juana-2's newest instant, so its absence here is
      // the `review IS NOT NULL` floor, not an ordering accident.
      expect(rows.map((r) => r.id)).not.toContain(seededIds['juana-bodyless']);
    });

    it('serves all three social_consent states — the internal surface applies no consent filter', async () => {
      const byId = new Map(seeded(listing.body).map((r) => [r.id, r]));
      // true: answered yes. false: answered no to SOCIAL MEDIA — the question
      // never covered internal station tools. null: submitted before the
      // question existed (~2024-06-20), i.e. never asked.
      expect(byId.get(seededIds['juana-1']).social_consent).toBe(true);
      expect(byId.get(seededIds['juana-2']).social_consent).toBe(false);
      expect(byId.get(seededIds['pratt']).social_consent).toBeNull();
    });

    it('never serves a bodyless submission (review IS NOT NULL floor)', async () => {
      // Prod holds 2 bodyless rows of 1,689. Checked on the unfiltered listing
      // and on both filters, since the floor lives in the shared buildWhere.
      const [byAlbum, byArtist] = await Promise.all([
        auth.get('/album-reviews').query({ album_id: String(libraryId), limit: 100 }),
        auth.get('/album-reviews').query({ artist: 'Juana Molina', limit: 100 }),
      ]);

      for (const res of [listing, byAlbum, byArtist]) {
        expect(res.status).toBe(200);
        expect(res.body.album_reviews.map((r) => r.id)).not.toContain(seededIds['juana-bodyless']);
        for (const row of res.body.album_reviews) {
          expect(row.review).not.toBeNull();
        }
      }
    });

    it('serves the full AlbumReview wire shape with no PII and no internal columns', async () => {
      const full = seeded(listing.body).find((r) => r.id === seededIds['juana-1']);

      expect(full).toEqual({
        id: seededIds['juana-1'],
        album_id: libraryId,
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        record_label: 'Sonamos',
        artist_blurb: 'Argentine electronic-folk auteur.',
        review: 'Hypnotic layered loops; a late-night staple.',
        recommended_tracks: '1, 3 (!!!!), 5',
        buzzwords: 'hypnotic, electronic, folk',
        fcc_violations: 'None',
        review_purpose: 'Rotation',
        rotated: true,
        released_within_six_months: true,
        social_consent: true,
        submitted_at: OLDEST,
      });

      // The load-bearing PII assertion: the seeded row HAS reviewer_raw and
      // social_consent_raw in the DB; the wire object must not carry the
      // keys at all (absent, not null).
      for (const row of seeded(listing.body)) {
        for (const internal of [
          'reviewer_raw',
          'social_consent_raw',
          'source',
          'source_key',
          'norm_artist',
          'norm_album',
          'add_date',
          'last_modified',
        ]) {
          expect(row).not.toHaveProperty(internal);
        }
      }
    });
  });

  describe('album_id filter', () => {
    it('returns exactly the submissions linked to the album — multi-review rows stay distinct', async () => {
      const res = await auth.get('/album-reviews').query({ album_id: String(libraryId), limit: 100 });
      expect(res.status).toBe(200);

      const rows = seeded(res.body);
      // juana-bodyless is linked to the same album and excluded by the body
      // floor, so this list is also the floor's window assertion.
      expect(rows.map((r) => r.id)).toEqual([seededIds['juana-2'], seededIds['juana-1']]);
      for (const row of rows) {
        expect(row.album_id).toBe(libraryId);
      }
    });
  });

  describe('artist filter (normalized exact match)', () => {
    it('matches case-insensitively', async () => {
      const res = await auth.get('/album-reviews').query({ artist: 'STEREOLAB', limit: 100 });
      expect(res.status).toBe(200);
      const rows = seeded(res.body);
      expect(rows.map((r) => r.id)).toEqual([seededIds['stereolab']]);
    });

    it('strips a leading "The " (normalizeArtistName SSOT)', async () => {
      const res = await auth.get('/album-reviews').query({ artist: 'The Stereolab', limit: 100 });
      expect(res.status).toBe(200);
      expect(seeded(res.body).map((r) => r.id)).toEqual([seededIds['stereolab']]);
    });

    it('returns no seeded rows for an unknown artist', async () => {
      const res = await auth.get('/album-reviews').query({ artist: 'No Such Probe Artist', limit: 100 });
      expect(res.status).toBe(200);
      expect(seeded(res.body)).toEqual([]);
    });
  });

  describe('pagination', () => {
    it('pages through the album_id window with PaginationInfo', async () => {
      const window = { album_id: String(libraryId) };

      const page1 = await auth.get('/album-reviews').query({ ...window, page: 1, limit: 1 });
      expect(page1.status).toBe(200);
      expect(page1.body.album_reviews).toHaveLength(1);
      expect(page1.body.album_reviews[0].id).toBe(seededIds['juana-2']);
      expect(page1.body.pagination).toEqual({ page: 1, limit: 1, total: 2, hasMore: true });

      const page2 = await auth.get('/album-reviews').query({ ...window, page: 2, limit: 1 });
      expect(page2.status).toBe(200);
      expect(page2.body.album_reviews).toHaveLength(1);
      expect(page2.body.album_reviews[0].id).toBe(seededIds['juana-1']);
      expect(page2.body.pagination).toEqual({ page: 2, limit: 1, total: 2, hasMore: false });
    });
  });

  describe('validation', () => {
    it.each([
      ['page', '0'],
      ['page', 'abc'],
      ['limit', '0'],
      ['limit', '101'],
      ['album_id', '0'],
      ['album_id', 'abc'],
      ['album_id', '3.5'],
      ['artist', ''],
      ['artist', 'a'.repeat(257)],
    ])('returns 400 for invalid %s', async (param, value) => {
      const res = await auth.get('/album-reviews').query({ [param]: value });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('message');
    });
  });
});
