/**
 * BS#1694 — public `GET /concerts/:id` (On Tour sharing).
 *
 * Postgres-backed sibling of concerts.spec.js (BS#1603), keyed by a
 * `bs1694:` source_id prefix so cleanup is a prefix DELETE and nothing leaks
 * across runs.
 *
 * Pins the by-id contract from `wxyc-shared/api.yaml` v1.18.0
 * (`/concerts/{id}`, wxyc-shared#236):
 *   - PUBLIC: a request with NO Authorization header succeeds — the share
 *     Worker and CDNs cannot mint anonymous sessions (the point of the
 *     ticket). The list stays behind anonymous-session auth, unchanged.
 *   - Serialization parity: the 200 body is the EXACT object the list
 *     endpoint emits for the same row (asserted by deep-equality against the
 *     list response, not duplicated literals).
 *   - WINDOWLESS: past rows and `removed_at`-tombstoned rows are served with
 *     whatever `status` they last carried — while remaining excluded from
 *     the list (the deliberate divergence).
 *   - Leak barrier holds: internal ingestion columns (removed_at above all,
 *     since tombstoned rows are now reachable) never reach the payload.
 *   - 404 for nonexistent ids, 400 for non-integer ids — both in the
 *     standard `{ message }` error shape.
 *   - `Cache-Control: public, max-age=300` on the 200 path.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1694:';
const VENUE_SLUG = 'bs1694-probe-room';
const ARTIST_NAME = 'BS#1694 Probe Headliner';
// Synthetic Discogs id for the resolved headliner; high enough to avoid
// colliding with any real artists/artist_metadata row in the CI clone.
const ARTIST_DISCOGS_ID = 91694001;
const ARTIST_GENRES = ['Folk, World, & Country'];

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

/** YYYY-MM-DD for today + offsetDays, in America/New_York (matches the list's default `from`). */
function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

const PAST = isoDate(-45); // long gone — invisible to the list's default window
const IN_15 = isoDate(15); // upcoming, resolved + enriched headliner
const IN_22 = isoDate(22); // tombstoned (removed_at set) — list-invisible, by-id-visible

const INTERNAL_COLUMNS = ['source', 'source_id', 'raw_data', 'scraped_at', 'first_scraped_at', 'removed_at'];

describe('GET /concerts/:id (BS#1694)', () => {
  let auth;
  let sql;
  let artistId;
  let upcomingId;
  let pastId;
  let removedId;

  /** Seeds one concert row and returns its serial id. */
  const seedConcert = async (overrides) => {
    const defaults = {
      source: 'triangle_shows',
      starts_at: null,
      doors_at: null,
      headlining_artist_id: null,
      title: null,
      supporting_artists: [],
      ticket_url: null,
      image_url: null,
      event_url: null,
      price_min: null,
      price_max: null,
      age_restriction: null,
      status: 'on_sale',
      removed_at: null,
    };
    const row = { ...defaults, ...overrides };
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, starts_at, doors_at,
          headlining_artist_raw, headlining_artist_id, title, supporting_artists_raw,
          ticket_url, image_url, price_min, price_max, age_restriction, status,
          removed_at, event_url, raw_data, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, '{}'::jsonb, now())
       RETURNING id`,
      [
        row.source,
        SOURCE_ID_PREFIX + row.key,
        row.venue_id,
        row.starts_on,
        row.starts_at,
        row.doors_at,
        row.headlining_artist_raw,
        row.headlining_artist_id,
        row.title,
        row.supporting_artists,
        row.ticket_url,
        row.image_url,
        row.price_min,
        row.price_max,
        row.age_restriction,
        row.status,
        row.removed_at,
        row.event_url,
      ]
    );
    return inserted.id;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = $1`, [ARTIST_DISCOGS_ID]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1`, [ARTIST_NAME]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup(); // idempotent across re-runs (shared schema, --runInBand)

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1694 Probe Room', 'Chapel Hill', 'NC', '100 E Franklin St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    const venueId = venue.id;

    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [ARTIST_NAME, ARTIST_DISCOGS_ID]
    );
    artistId = artist.id;

    // Genre enrichment for the resolved headliner (BS#1624 projection) — the
    // parity test below proves the by-id read carries the same enrichment
    // fields as the list.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles)
       VALUES ($1, $2, $3)`,
      [ARTIST_DISCOGS_ID, ARTIST_GENRES, []]
    );

    // Upcoming, fully-populated, resolved headliner: the serialization-parity
    // row (starts_at at 23:30Z stays the same ET calendar date, so the derive
    // trigger's recomputed starts_on remains IN_15).
    upcomingId = await seedConcert({
      key: 'upcoming',
      venue_id: venueId,
      starts_on: IN_15,
      starts_at: `${IN_15}T23:30:00.000Z`,
      doors_at: `${IN_15}T22:30:00.000Z`,
      headlining_artist_raw: ARTIST_NAME,
      headlining_artist_id: artistId,
      supporting_artists: ['Probe Opener'],
      ticket_url: 'https://example.com/tickets/bs1694',
      image_url: 'https://example.com/img/bs1694.jpg',
      event_url: 'https://example.com/venue/event/bs1694',
      price_min: '18.00',
      price_max: '22.00',
      age_restriction: 'All Ages',
    });

    // Long-past row: outside every list window, but the share page must still
    // render it ("this one's passed").
    pastId = await seedConcert({
      key: 'past',
      venue_id: venueId,
      starts_on: PAST,
      headlining_artist_raw: 'Bygone Probe Act',
    });

    // Tombstoned row: removed_at set, status as the source last carried it.
    removedId = await seedConcert({
      key: 'removed',
      venue_id: venueId,
      starts_on: IN_22,
      headlining_artist_raw: 'Delisted Probe Act',
      status: 'cancelled',
      removed_at: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  describe('public access (no session)', () => {
    it('serves a request with NO Authorization header', async () => {
      // Plain requester — no bearer of any kind. This is the point of the
      // ticket: the share Worker and CDNs cannot mint anonymous sessions.
      const res = await request.get(`/concerts/${upcomingId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(upcomingId);
    });

    it('marks the response publicly cacheable with a 5-minute TTL', async () => {
      const res = await request.get(`/concerts/${upcomingId}`);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
    });
  });

  describe('serialization parity with the list', () => {
    it('emits the exact Concert object GET /concerts serializes for the same row', async () => {
      // The list's rendering is the reference — fetched, not re-derived, so
      // this cannot drift into a second hand-maintained shape.
      const list = await auth.get('/concerts').query({ from: IN_15, to: IN_15, limit: 100 });
      expect(list.status).toBe(200);
      const reference = list.body.concerts.find((c) => c.id === upcomingId);
      expect(reference).toBeDefined();
      // Sanity that the reference row exercises the full shape, enrichment
      // included (genres via the BS#1624 LEFT JOIN).
      expect(reference.genres).toEqual(ARTIST_GENRES);

      const byId = await request.get(`/concerts/${upcomingId}`);
      expect(byId.status).toBe(200);
      expect(byId.body).toEqual(reference);
    });
  });

  describe('windowless reads', () => {
    it('serves a long-past concert the list will never emit', async () => {
      const res = await request.get(`/concerts/${pastId}`);
      expect(res.status).toBe(200);
      expect(res.body.starts_on).toBe(PAST);
      expect(res.body.headlining_artist_raw).toBe('Bygone Probe Act');
    });

    it('serves a tombstoned concert with the status it last carried', async () => {
      const res = await request.get(`/concerts/${removedId}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.starts_on).toBe(IN_22);
    });

    it('keeps the tombstoned row excluded from the list (the deliberate divergence)', async () => {
      const list = await auth.get('/concerts').query({ from: IN_22, to: IN_22, limit: 100 });
      expect(list.status).toBe(200);
      expect(list.body.concerts.find((c) => c.id === removedId)).toBeUndefined();
    });

    it('never leaks internal ingestion columns — removed_at above all', async () => {
      const res = await request.get(`/concerts/${removedId}`);
      for (const internal of INTERNAL_COLUMNS) {
        expect(res.body).not.toHaveProperty(internal);
        expect(res.body.venue).not.toHaveProperty(internal);
      }
    });
  });

  describe('misses', () => {
    /**
     * A guaranteed-missing id derived from the live table (MAX + 1) rather
     * than a hardcoded literal — the schema is shared across suites, so a
     * fixed value would silently flip to 200 if any other spec ever seeded
     * an explicit high id.
     */
    const missingId = async () => {
      const [{ next_id: nextId }] = await sql.unsafe(
        `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM "${SCHEMA}".concerts`
      );
      return nextId;
    };

    // Misses must never be edge-cached: 404 is heuristically cacheable by
    // default (RFC 9110 §15.5.5), so without the explicit no-store a CDN
    // could pin "dead" onto an id minutes before its row lands (concert ids
    // are predictable serials). The explicit directive enforces what
    // omission only implied.
    it('returns 404 pinned no-store in the standard error shape for an id with no row', async () => {
      const res = await request.get(`/concerts/${await missingId()}`);
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('message');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns 404 (not a bind 500) for an all-digits id beyond the int4 serial range', async () => {
      const res = await request.get('/concerts/99999999999999');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('message');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each([['abc'], ['12abc'], ['0']])(
      'returns 400 pinned no-store in the standard error shape for non-integer id %s',
      async (id) => {
        const res = await request.get(`/concerts/${id}`);
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('message');
        expect(res.headers['cache-control']).toBe('no-store');
      }
    );

    // A malformed percent-escape fails URL-decoding inside the Express
    // router itself — before any controller runs. That URIError carries
    // `status: 400` (not `statusCode`), which the errorHandler must answer
    // as a clean client error: pre-fix it surfaced as a 500 plus a Sentry
    // capture, mintable by any unauthenticated probe on this public route
    // (a share link truncated mid-escape is enough).
    it('returns 400 in the standard error shape for a malformed percent-escape', async () => {
      const res = await request.get('/concerts/%ZZ');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('message');
    });
  });
});
