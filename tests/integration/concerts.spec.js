/**
 * BS#1603 — `GET /concerts` (On Tour feed, on-tour Phase 2).
 *
 * Postgres-backed: direct SQL seeds one venue and a deterministic set of
 * concert rows keyed by a `bs1603:` source_id prefix, so cleanup is a
 * prefix DELETE and nothing leaks across runs. Dates are computed relative
 * to "today" because the endpoint's default window is "today forward".
 *
 * Pins the load-bearing server contract:
 *   - windowing happens on `starts_on` — the date-only row (NULL
 *     `starts_at`) MUST appear inside the window (the classic
 *     starts_at-vs-starts_on regression from the issue's acceptance
 *     criteria);
 *   - past and `removed_at`-tombstoned rows are excluded;
 *   - `curated=true` narrows to resolver-stamped rows (broad predicate:
 *     headlining_artist_id IS NOT NULL AND removed_at IS NULL);
 *   - ordering by `starts_on` ascending + page/limit pagination with
 *     PaginationInfo;
 *   - the embedded venue object and the absence of internal ingestion
 *     columns in the payload;
 *   - anonymous-session auth (bearer required — AUTH_BYPASS still enforces
 *     the header).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1603:';
const VENUE_SLUG = 'bs1603-probe-room';
const ARTIST_NAME = 'BS#1603 Touring Probe Artist';
// Synthetic Discogs id for the resolved headliner; high enough to avoid
// colliding with any real artists/artist_metadata row in the CI clone.
const ARTIST_DISCOGS_ID = 91624001;
const ARTIST_GENRES = ['Rock', 'Electronic'];
const ARTIST_STYLES = ['Indie Rock'];

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

/** YYYY-MM-DD for today + offsetDays, in America/New_York (matches the endpoint's default `from`). */
function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

// Seeded starts_on dates, all offsets from today (venue-local).
const PAST = isoDate(-30); // outside the default window
const IN_10 = isoDate(10); // timed row, curated (resolved headliner)
const IN_20 = isoDate(20); // date-only row (NULL starts_at) — the regression row
const IN_25 = isoDate(25); // removed (tombstoned) row — must never appear
const IN_30 = isoDate(30); // timed row, unresolved headliner
const IN_40 = isoDate(40); // date-only row, beyond the from/to sub-window used below

describe('GET /concerts (BS#1603)', () => {
  let auth;
  let sql;
  let artistId;

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
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, starts_at, doors_at,
          headlining_artist_raw, headlining_artist_id, title, supporting_artists_raw,
          ticket_url, image_url, price_min, price_max, age_restriction, status,
          removed_at, event_url, raw_data, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, '{}'::jsonb, now())`,
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
       VALUES ($1, 'BS1603 Probe Room', 'Carrboro', 'NC', '300 E Main St')
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

    // Enrichment output for the resolved headliner: the BS#1624 genres
    // projection LEFT JOINs artist_metadata on COALESCE(headlining_discogs_
    // artist_id, artists.discogs_artist_id). Seeding a row here proves genres
    // surface on the wire; the un-enriched rows below prove the null-safe miss.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles)
       VALUES ($1, $2, $3)`,
      [ARTIST_DISCOGS_ID, ARTIST_GENRES, ARTIST_STYLES]
    );

    // Past row — excluded by the default "today forward" window.
    await seedConcert({
      key: 'past',
      venue_id: venueId,
      starts_on: PAST,
      headlining_artist_raw: 'Long Gone Act',
    });

    // Timed + curated row: starts_at present (the derive trigger recomputes
    // starts_on from it), headliner resolved, fully populated optionals.
    await seedConcert({
      key: 'timed-curated',
      venue_id: venueId,
      starts_on: IN_10,
      starts_at: `${IN_10}T23:30:00.000Z`,
      doors_at: `${IN_10}T22:30:00.000Z`,
      headlining_artist_raw: ARTIST_NAME,
      headlining_artist_id: artistId,
      supporting_artists: ['Opener A', 'Opener B'],
      ticket_url: 'https://example.com/tickets/bs1603',
      image_url: 'https://example.com/img/bs1603.jpg',
      event_url: 'https://example.com/venue/event/bs1603',
      price_min: '25.00',
      price_max: '28.50',
      age_restriction: 'All Ages',
    });

    // Date-only row (NULL starts_at) — THE regression row: a range
    // predicate on starts_at would silently drop it.
    await seedConcert({
      key: 'date-only',
      venue_id: venueId,
      starts_on: IN_20,
      headlining_artist_raw: 'Date-Only Billing',
      title: 'Date-Only Billing with special guests',
    });

    // Tombstoned row — must never appear, curated or not.
    await seedConcert({
      key: 'removed',
      venue_id: venueId,
      starts_on: IN_25,
      headlining_artist_raw: ARTIST_NAME,
      headlining_artist_id: artistId,
      removed_at: new Date().toISOString(),
    });

    // Timed, unresolved headliner — in the broad feed, not the curated one.
    // 22:00Z is mid-evening Eastern on the same calendar date, so the
    // starts_on the derive trigger recomputes from starts_at stays IN_30.
    await seedConcert({
      key: 'timed-unresolved',
      venue_id: venueId,
      starts_on: IN_30,
      starts_at: `${IN_30}T22:00:00.000Z`,
      headlining_artist_raw: 'Unresolved Billing String',
    });

    // Far-future date-only row — outside the from/to sub-window below.
    await seedConcert({
      key: 'far-future',
      venue_id: venueId,
      starts_on: IN_40,
      headlining_artist_raw: 'Far Future Act',
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  /** Concerts from a response body that belong to this spec's seed. */
  const seeded = (body) => body.concerts.filter((c) => c.venue.slug === VENUE_SLUG);

  describe('auth', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request.get('/concerts');
      expect(res.status).toBe(401);
    });
  });

  describe('default window (today forward)', () => {
    it('returns upcoming non-removed rows ordered by starts_on, including the date-only row', async () => {
      const res = await auth.get('/concerts').query({ limit: 100 });
      expect(res.status).toBe(200);

      const rows = seeded(res.body);
      const keys = rows.map((c) => c.headlining_artist_raw);

      // The date-only (NULL starts_at) row is present — the regression assertion.
      const dateOnly = rows.find((c) => c.headlining_artist_raw === 'Date-Only Billing');
      expect(dateOnly).toBeDefined();
      expect(dateOnly.starts_at).toBeNull();
      expect(dateOnly.starts_on).toBe(IN_20);
      // BS#1609: event_url is present in the projection and null when the row
      // has no known venue page (iOS falls back to ticket_url) — asserting
      // `null` (not absent) pins that the backend always emits the key.
      expect(dateOnly.event_url).toBeNull();

      // Past and removed rows are absent.
      expect(keys).not.toContain('Long Gone Act');
      expect(rows.filter((c) => c.headlining_artist_raw === ARTIST_NAME)).toHaveLength(1);

      // Ordered by starts_on ascending.
      expect(keys).toEqual([ARTIST_NAME, 'Date-Only Billing', 'Unresolved Billing String', 'Far Future Act']);
    });

    it('serves the full Concert wire shape with the venue embedded and no internal columns', async () => {
      const res = await auth.get('/concerts').query({ limit: 100 });
      const timed = seeded(res.body).find((c) => c.headlining_artist_raw === ARTIST_NAME);

      expect(timed).toMatchObject({
        starts_on: IN_10,
        headlining_artist_id: artistId,
        supporting_artists_raw: ['Opener A', 'Opener B'],
        ticket_url: 'https://example.com/tickets/bs1603',
        image_url: 'https://example.com/img/bs1603.jpg',
        event_url: 'https://example.com/venue/event/bs1603',
        price_min: 25,
        price_max: 28.5,
        age_restriction: 'All Ages',
        status: 'on_sale',
        venue: {
          slug: VENUE_SLUG,
          name: 'BS1603 Probe Room',
          city: 'Carrboro',
          state: 'NC',
          address: '300 E Main St',
        },
      });
      expect(typeof timed.id).toBe('number');
      expect(new Date(timed.starts_at).toISOString()).toBe(`${IN_10}T23:30:00.000Z`);
      expect(new Date(timed.doors_at).toISOString()).toBe(`${IN_10}T22:30:00.000Z`);

      for (const internal of ['source', 'source_id', 'raw_data', 'scraped_at', 'first_scraped_at', 'removed_at']) {
        expect(timed).not.toHaveProperty(internal);
        expect(timed.venue).not.toHaveProperty(internal);
      }
    });
  });

  describe('genres projection (BS#1624)', () => {
    it('surfaces artist_metadata.genres on a resolved headliner and leaves un-enriched rows null', async () => {
      const res = await auth.get('/concerts').query({ limit: 100 });
      expect(res.status).toBe(200);
      const rows = seeded(res.body);

      // Resolved headliner (artists.discogs_artist_id → artist_metadata) →
      // genres projected onto the wire.
      const enriched = rows.find((c) => c.headlining_artist_raw === ARTIST_NAME);
      expect(enriched).toBeDefined();
      expect(enriched.genres).toEqual(ARTIST_GENRES);

      // Un-enriched row (unresolved headliner, no artist_metadata) → the LEFT
      // JOIN misses and the field is null, never an empty array or absent.
      const unenriched = rows.find((c) => c.headlining_artist_raw === 'Date-Only Billing');
      expect(unenriched).toBeDefined();
      expect(unenriched.genres).toBeNull();
    });
  });

  describe('from/to window on starts_on', () => {
    it('narrows to rows inside the inclusive window', async () => {
      const res = await auth.get('/concerts').query({ from: IN_20, to: IN_30, limit: 100 });
      expect(res.status).toBe(200);
      const keys = seeded(res.body).map((c) => c.headlining_artist_raw);
      expect(keys).toEqual(['Date-Only Billing', 'Unresolved Billing String']);
    });

    it('includes past rows when from reaches back', async () => {
      const res = await auth.get('/concerts').query({ from: PAST, to: PAST, limit: 100 });
      expect(res.status).toBe(200);
      const keys = seeded(res.body).map((c) => c.headlining_artist_raw);
      expect(keys).toEqual(['Long Gone Act']);
    });
  });

  describe('curated=true', () => {
    it('returns only resolver-stamped, non-removed rows', async () => {
      const res = await auth.get('/concerts').query({ curated: 'true', limit: 100 });
      expect(res.status).toBe(200);
      const rows = seeded(res.body);
      expect(rows).toHaveLength(1);
      expect(rows[0].headlining_artist_raw).toBe(ARTIST_NAME);
      expect(rows[0].headlining_artist_id).toBe(artistId);
    });
  });

  describe('pagination', () => {
    it('pages through the window with PaginationInfo', async () => {
      // Constrain to this spec's rows via the sub-window so totals are exact.
      const window = { from: IN_10, to: IN_40 };

      const page1 = await auth.get('/concerts').query({ ...window, page: 1, limit: 3 });
      expect(page1.status).toBe(200);
      expect(page1.body.concerts).toHaveLength(3);
      expect(page1.body.pagination).toEqual({ page: 1, limit: 3, total: 4, hasMore: true });

      const page2 = await auth.get('/concerts').query({ ...window, page: 2, limit: 3 });
      expect(page2.status).toBe(200);
      expect(page2.body.concerts).toHaveLength(1);
      expect(page2.body.pagination).toEqual({ page: 2, limit: 3, total: 4, hasMore: false });

      const seen = [...page1.body.concerts, ...page2.body.concerts].map((c) => c.headlining_artist_raw);
      expect(seen).toEqual([ARTIST_NAME, 'Date-Only Billing', 'Unresolved Billing String', 'Far Future Act']);
    });
  });

  describe('validation', () => {
    it.each([
      ['page', '0'],
      ['page', 'abc'],
      ['limit', '0'],
      ['limit', '101'],
      ['from', 'not-a-date'],
      ['to', '07/04/2026'],
      ['curated', 'maybe'],
    ])('returns 400 for invalid %s=%s', async (param, value) => {
      const res = await auth.get('/concerts').query({ [param]: value });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('message');
    });
  });
});

/**
 * BS#1731 — `Concert.station_recommended`: true iff the resolved headliner
 * (`headlining_artist_id`) has ≥1 `library` release with ≥1 `rotation` row
 * (any bin, regardless of `kill_date`), false/omitted otherwise.
 *
 * Isolated from the BS#1603 describe above (own venue/source_id prefix) so
 * these seeds can't perturb that block's exact-array ordering/pagination
 * assertions.
 */
describe('GET /concerts station_recommended (BS#1731)', () => {
  const VENUE_SLUG = 'bs1731-probe-room';
  const SOURCE_ID_PREFIX = 'bs1731:';
  const ROTATED_ARTIST_NAME = 'BS#1731 Rotation-Backed Probe Artist';
  const UNROTATED_ARTIST_NAME = 'BS#1731 Unrotated Probe Artist';
  const DISCOGS_ONLY_ARTIST_RAW = 'BS#1731 Discogs-Only Probe Artist';
  const DISCOGS_ONLY_ARTIST_DISCOGS_ID = 91731001;
  const STARTS_ON = isoDate(15);

  let auth;
  let sql;
  let libraryId;

  const insertConcert = async (venueId, key, overrides) => {
    const defaults = {
      source: 'triangle_shows',
      starts_at: null,
      doors_at: null,
      headlining_artist_id: null,
      headlining_discogs_artist_id: null,
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
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, starts_at, doors_at,
          headlining_artist_raw, headlining_artist_id, headlining_discogs_artist_id,
          title, supporting_artists_raw, ticket_url, image_url, price_min, price_max,
          age_restriction, status, removed_at, event_url, raw_data, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, '{}'::jsonb, now())`,
      [
        row.source,
        SOURCE_ID_PREFIX + key,
        venueId,
        STARTS_ON,
        row.starts_at,
        row.doors_at,
        row.headlining_artist_raw,
        row.headlining_artist_id,
        row.headlining_discogs_artist_id,
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
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".rotation WHERE album_id IN (SELECT id FROM "${SCHEMA}".library WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name = $1))`,
      [ROTATED_ARTIST_NAME]
    );
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".library WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name = $1)`,
      [ROTATED_ARTIST_NAME]
    );
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name IN ($1, $2)`, [
      ROTATED_ARTIST_NAME,
      UNROTATED_ARTIST_NAME,
    ]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup(); // idempotent across re-runs (shared schema, --runInBand)

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1731 Probe Room', 'Carrboro', 'NC', '300 E Main St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    const venueId = venue.id;

    const [rotatedArtist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [ROTATED_ARTIST_NAME]
    );
    const [unrotatedArtist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [UNROTATED_ARTIST_NAME]
    );

    // Rotation-linked library release for the rotated artist: the true case.
    const [libraryRow] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, (SELECT id FROM "${SCHEMA}".genres LIMIT 1), (SELECT id FROM "${SCHEMA}".format LIMIT 1), $2, 1)
       RETURNING id`,
      [rotatedArtist.id, `${ROTATED_ARTIST_NAME} LP`]
    );
    libraryId = libraryRow.id;
    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H')`, [libraryId]);

    await insertConcert(venueId, 'rotated', {
      headlining_artist_raw: ROTATED_ARTIST_NAME,
      headlining_artist_id: rotatedArtist.id,
    });
    // Resolved headliner with no library/rotation row at all: the false case.
    await insertConcert(venueId, 'unrotated', {
      headlining_artist_raw: UNROTATED_ARTIST_NAME,
      headlining_artist_id: unrotatedArtist.id,
    });
    // Discogs-only resolution (headlining_artist_id NULL): false/omitted by
    // construction, since the EXISTS correlates on headlining_artist_id.
    await insertConcert(venueId, 'discogs-only', {
      headlining_artist_raw: DISCOGS_ONLY_ARTIST_RAW,
      headlining_discogs_artist_id: DISCOGS_ONLY_ARTIST_DISCOGS_ID,
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  const findByRaw = (body, raw) => body.concerts.find((c) => c.headlining_artist_raw === raw);

  it('emits true for a headliner with a rotation-linked library release', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    expect(res.status).toBe(200);
    const concert = findByRaw(res.body, ROTATED_ARTIST_NAME);
    expect(concert).toBeDefined();
    expect(concert.station_recommended).toBe(true);
  });

  it('emits false for a resolved headliner with no rotation row', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    expect(res.status).toBe(200);
    const concert = findByRaw(res.body, UNROTATED_ARTIST_NAME);
    expect(concert).toBeDefined();
    expect(concert.station_recommended).toBe(false);
  });

  it('emits false or omits the field for a Discogs-only resolved headliner', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    expect(res.status).toBe(200);
    const concert = findByRaw(res.body, DISCOGS_ONLY_ARTIST_RAW);
    expect(concert).toBeDefined();
    expect(concert.headlining_artist_id).toBeNull();
    expect(concert.station_recommended === false || concert.station_recommended === undefined).toBe(true);
  });

  it('agrees between GET /concerts and GET /concerts/:id for the rotated headliner', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    const concert = findByRaw(res.body, ROTATED_ARTIST_NAME);
    const byId = await auth.get(`/concerts/${concert.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.station_recommended).toBe(true);
  });
});
