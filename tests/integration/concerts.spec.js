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
const ARTIST_BIO = 'A touring probe artist known for genre-blending live sets.';

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

    // Enrichment output for the resolved headliner: the BS#1624 genres /
    // BS#1734 artist_bio projection LEFT JOINs artist_metadata on
    // COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id).
    // Seeding a row here proves genres/artist_bio surface on the wire; the
    // un-enriched rows below prove the null-safe miss.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles, artist_bio)
       VALUES ($1, $2, $3, $4)`,
      [ARTIST_DISCOGS_ID, ARTIST_GENRES, ARTIST_STYLES, ARTIST_BIO]
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

  describe('artist_bio projection (BS#1734)', () => {
    it('surfaces artist_metadata.artist_bio on a resolved headliner and leaves un-enriched rows null', async () => {
      const res = await auth.get('/concerts').query({ limit: 100 });
      expect(res.status).toBe(200);
      const rows = seeded(res.body);

      const enriched = rows.find((c) => c.headlining_artist_raw === ARTIST_NAME);
      expect(enriched).toBeDefined();
      expect(enriched.artist_bio).toBe(ARTIST_BIO);

      const unenriched = rows.find((c) => c.headlining_artist_raw === 'Date-Only Billing');
      expect(unenriched).toBeDefined();
      expect(unenriched.artist_bio).toBeNull();
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
 * BS#1762 — curated feed includes support-resolved concerts: migration 0129
 * widens `concerts_curated_starts_on_idx` (and `buildWhere`'s curated branch
 * in concerts.service.ts) to a third OR term, `has_resolved_support`.
 * Extends the BS#1603 broad-curation decision ("resolution is a realness
 * proxy") to supporting acts, the same way BS#1614 already did for a
 * Discogs-only-resolved headliner.
 *
 * `has_resolved_support` is a denormalized flag maintained by
 * `jobs/concerts-artist-resolver`'s support sync/resolve/recompute step
 * (BS#1760) from the `concert_performers` junction — this suite seeds the
 * flag directly rather than the junction, since it exercises the READ path
 * (the index + buildWhere widening), not the resolver that maintains the
 * flag (covered by tests/integration/concerts-artist-resolver-support.spec.js).
 *
 * Isolated from the BS#1603/BS#1731/BS#1756 describes above (own
 * venue/source_id prefix) so these seeds can't perturb their assertions.
 */
describe('GET /concerts curated (support-resolved, BS#1762)', () => {
  const VENUE_SLUG = 'bs1762-probe-room';
  const SOURCE_ID_PREFIX = 'bs1762:';
  const SUPPORT_ONLY_ARTIST_RAW = 'BS#1762 Support-Only Probe Headliner';
  const HEADLINER_ONLY_ARTIST_NAME = 'BS#1762 Headliner-Only Probe Artist';
  const UNRESOLVED_ARTIST_RAW = 'BS#1762 Unresolved Probe Headliner';
  const STARTS_ON = isoDate(17);

  let auth;
  let sql;

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
      has_resolved_support: false,
    };
    const row = { ...defaults, ...overrides };
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, starts_at, doors_at,
          headlining_artist_raw, headlining_artist_id, headlining_discogs_artist_id,
          title, supporting_artists_raw, ticket_url, image_url, price_min, price_max,
          age_restriction, status, removed_at, event_url, has_resolved_support,
          raw_data, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, '{}'::jsonb, now())`,
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
        row.has_resolved_support,
      ]
    );
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1`, [HEADLINER_ONLY_ARTIST_NAME]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup(); // idempotent across re-runs (shared schema, --runInBand)

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1762 Probe Room', 'Carrboro', 'NC', '300 E Main St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    const venueId = venue.id;

    const [headlinerArtist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [HEADLINER_ONLY_ARTIST_NAME]
    );

    // Support-only-resolved: no headliner resolution in either lane, but a
    // support act resolved — the new curated lane this migration adds.
    await insertConcert(venueId, 'support-only', {
      headlining_artist_raw: SUPPORT_ONLY_ARTIST_RAW,
      has_resolved_support: true,
    });

    // Headliner-only-resolved: the pre-existing curated lane (BS#1603).
    // Membership must be unaffected by the widened predicate.
    await insertConcert(venueId, 'headliner-only', {
      headlining_artist_raw: HEADLINER_ONLY_ARTIST_NAME,
      headlining_artist_id: headlinerArtist.id,
    });

    // Negative control: no headliner resolution in either lane AND no
    // resolved support. Must stay excluded from the curated feed — proves
    // the widening didn't accidentally broaden the predicate past the three
    // named lanes.
    await insertConcert(venueId, 'unresolved', {
      headlining_artist_raw: UNRESOLVED_ARTIST_RAW,
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  const findByRaw = (body, raw) => body.concerts.find((c) => c.headlining_artist_raw === raw);

  it('includes a support-only-resolved concert in the curated feed', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, curated: 'true', limit: 100 });
    expect(res.status).toBe(200);
    const concert = findByRaw(res.body, SUPPORT_ONLY_ARTIST_RAW);
    expect(concert).toBeDefined();
    expect(concert.headlining_artist_id).toBeNull();
  });

  it("leaves a headliner-only concert's curated membership unchanged", async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, curated: 'true', limit: 100 });
    expect(res.status).toBe(200);
    const concert = findByRaw(res.body, HEADLINER_ONLY_ARTIST_NAME);
    expect(concert).toBeDefined();
  });

  it('excludes a concert with no resolved headliner and no resolved support', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, curated: 'true', limit: 100 });
    expect(res.status).toBe(200);
    const concert = findByRaw(res.body, UNRESOLVED_ARTIST_RAW);
    expect(concert).toBeUndefined();
  });

  it('all three probe rows are present in the uncurated feed (sanity check: curated genuinely filters)', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    expect(res.status).toBe(200);
    expect(findByRaw(res.body, SUPPORT_ONLY_ARTIST_RAW)).toBeDefined();
    expect(findByRaw(res.body, HEADLINER_ONLY_ARTIST_NAME)).toBeDefined();
    expect(findByRaw(res.body, UNRESOLVED_ARTIST_RAW)).toBeDefined();
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
  const KILLED_ROTATION_ARTIST_NAME = 'BS#1731 Killed-Rotation Probe Artist';
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
    // Both library-bearing artists (the active-rotation and killed-rotation probes).
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".rotation WHERE album_id IN (SELECT id FROM "${SCHEMA}".library WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name IN ($1, $2)))`,
      [ROTATED_ARTIST_NAME, KILLED_ROTATION_ARTIST_NAME]
    );
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".library WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name IN ($1, $2))`,
      [ROTATED_ARTIST_NAME, KILLED_ROTATION_ARTIST_NAME]
    );
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name IN ($1, $2, $3)`, [
      ROTATED_ARTIST_NAME,
      KILLED_ROTATION_ARTIST_NAME,
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

    // Fan-out guard (BS#1731): a second rotation row on the same release AND a
    // second rotation-linked release for the same artist. `station_recommended`
    // is a scalar EXISTS, not a JOIN into the outer query, so these extra rows
    // must NOT duplicate the rotated concert in the page — pinned below. A
    // regression that turned the EXISTS into a join would multiply this row.
    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'M')`, [libraryId]);
    const [rotatedSecondRelease] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, (SELECT id FROM "${SCHEMA}".genres LIMIT 1), (SELECT id FROM "${SCHEMA}".format LIMIT 1), $2, 2)
       RETURNING id`,
      [rotatedArtist.id, `${ROTATED_ARTIST_NAME} EP`]
    );
    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'L')`, [
      rotatedSecondRelease.id,
    ]);

    // Killed-rotation artist: its only release left rotation long ago (past
    // kill_date). The EXISTS deliberately does NOT filter kill_date, so this is
    // still "ever in rotation" → true. This is the one behavior that distinguishes
    // station_recommended from the repo's active-only rotation predicates
    // (isActiveRotationMatch, rotation_library_view); without this fixture a
    // regression adding a `kill_date IS NULL` filter would pass the whole suite.
    const [killedRotationArtist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [KILLED_ROTATION_ARTIST_NAME]
    );
    const [killedLibraryRow] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, (SELECT id FROM "${SCHEMA}".genres LIMIT 1), (SELECT id FROM "${SCHEMA}".format LIMIT 1), $2, 1)
       RETURNING id`,
      [killedRotationArtist.id, `${KILLED_ROTATION_ARTIST_NAME} LP`]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin, add_date, kill_date)
       VALUES ($1, 'H', '2005-01-01', '2005-06-01')`,
      [killedLibraryRow.id]
    );

    await insertConcert(venueId, 'rotated', {
      headlining_artist_raw: ROTATED_ARTIST_NAME,
      headlining_artist_id: rotatedArtist.id,
    });
    // Resolved headliner whose sole rotation ended years ago (past kill_date):
    // still "ever in rotation" → true (BS#1731 semantics).
    await insertConcert(venueId, 'killed-rotation', {
      headlining_artist_raw: KILLED_ROTATION_ARTIST_NAME,
      headlining_artist_id: killedRotationArtist.id,
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

  it('emits true for a headliner whose only rotation row is long killed (ever-in-rotation semantics)', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    expect(res.status).toBe(200);
    const concert = findByRaw(res.body, KILLED_ROTATION_ARTIST_NAME);
    expect(concert).toBeDefined();
    // Deliberate: BS#1731 counts past rotations. If the EXISTS ever gains a
    // `kill_date IS NULL`/`> now()` filter (the active-rotation convention),
    // this flips to false and fails here.
    expect(concert.station_recommended).toBe(true);
  });

  it('returns the rotated headliner exactly once despite multiple rotation/library rows (scalar EXISTS, no fan-out)', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    expect(res.status).toBe(200);
    const matches = res.body.concerts.filter((c) => c.headlining_artist_raw === ROTATED_ARTIST_NAME);
    expect(matches).toHaveLength(1);
    expect(matches[0].station_recommended).toBe(true);
  });

  it('agrees between GET /concerts and GET /concerts/:id for the rotated headliner', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    const concert = findByRaw(res.body, ROTATED_ARTIST_NAME);
    const byId = await auth.get(`/concerts/${concert.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.station_recommended).toBe(true);
  });

  it('agrees between GET /concerts and GET /concerts/:id for the false and Discogs-only headliners', async () => {
    const res = await auth.get('/concerts').query({ from: STARTS_ON, to: STARTS_ON, limit: 100 });
    expect(res.status).toBe(200);

    // Unrotated resolved headliner: false on the page → false by-id.
    const unrotated = findByRaw(res.body, UNROTATED_ARTIST_NAME);
    expect(unrotated).toBeDefined();
    const unrotatedById = await auth.get(`/concerts/${unrotated.id}`);
    expect(unrotatedById.status).toBe(200);
    expect(unrotatedById.body.station_recommended).toBe(false);

    // Discogs-only headliner: the by-id projection also selects the EXISTS, so
    // it likewise yields a concrete false (never null) — the EXISTS can't
    // correlate a NULL headlining_artist_id.
    const discogsOnly = findByRaw(res.body, DISCOGS_ONLY_ARTIST_RAW);
    expect(discogsOnly).toBeDefined();
    const discogsOnlyById = await auth.get(`/concerts/${discogsOnly.id}`);
    expect(discogsOnlyById.status).toBe(200);
    expect(discogsOnlyById.body.station_recommended).toBe(false);
  });
});

/**
 * BS#1756 — `Concert.station_recommended_rank`: the 1-based rank of a
 * concert within the BS#1731 `station_recommended` gated set, ordered by
 * all-time WXYC plays (`artist_station_plays.plays`) descending, ties broken
 * `starts_on ASC, id ASC`, null plays sorting last. Computed over the ENTIRE
 * gated upcoming window (`removed_at IS NULL AND starts_on >= from AND
 * station_recommended`) — bounded by `from` only, never the request's `to`,
 * `curated`, or (the load-bearing property) the page's `limit`/`offset`.
 *
 * Isolated from the BS#1603/BS#1731 describes above (own venue/source_id
 * prefix, own artist-name prefix) so these seeds can't perturb their
 * assertions.
 *
 * The rank domain is GLOBAL — every upcoming gated concert in the DB, not
 * just this spec's seeded venue — so assertions below prove RELATIVE order
 * within the seeded set (never an absolute `toBe(N)`), which the SQL
 * guarantees regardless of what else is gated elsewhere in the DB. Also
 * covers: a PAST gated concert's by-id rank (null, via the windowless
 * `getConcertById` read re-testing `starts_on >= today`) and the rank
 * subquery's final `id ASC` tie-break clause (equal plays AND equal
 * starts_on).
 */
describe('GET /concerts station_recommended_rank (BS#1756)', () => {
  const VENUE_SLUG = 'bs1756-probe-room';
  const SOURCE_ID_PREFIX = 'bs1756:';
  const ARTIST_NAME_PREFIX = 'BS#1756 Probe ';
  const RANK1_ARTIST_NAME = `${ARTIST_NAME_PREFIX}Rank1 Artist`; // plays 500
  const RANK2_ARTIST_NAME = `${ARTIST_NAME_PREFIX}Rank2 Artist`; // plays 300
  const RANK3_ARTIST_NAME = `${ARTIST_NAME_PREFIX}Rank3 Artist`; // plays 150
  const TIE_EARLIER_ARTIST_NAME = `${ARTIST_NAME_PREFIX}TieEarlier Artist`; // plays 100, earlier date
  const TIE_LATER_ARTIST_NAME = `${ARTIST_NAME_PREFIX}TieLater Artist`; // plays 100, later date
  const NO_PLAYS_ARTIST_NAME = `${ARTIST_NAME_PREFIX}NoPlays Artist`; // gated, no artist_station_plays row
  const UNROTATED_ARTIST_NAME = `${ARTIST_NAME_PREFIX}Unrotated Artist`; // resolved, not gated
  const DISCOGS_ONLY_ARTIST_RAW = `${ARTIST_NAME_PREFIX}Discogs-Only Artist`; // never gated
  const DISCOGS_ONLY_ARTIST_DISCOGS_ID = 91756001;
  // Gated, plays row, but on a PAST date — the by-id windowless+today-guard
  // case (only reachable via GET /concerts/:id; excluded from the default
  // GET /concerts window entirely).
  const PAST_GATED_ARTIST_NAME = `${ARTIST_NAME_PREFIX}PastGated Artist`;
  // Two gated artists with EQUAL plays whose concerts share a starts_on date,
  // isolating the rank subquery's final `id ASC` tie-break clause (plays tie
  // AND date tie, so only concert id can order them).
  const ID_TIE_ARTIST_A_NAME = `${ARTIST_NAME_PREFIX}IdTieA Artist`;
  const ID_TIE_ARTIST_B_NAME = `${ARTIST_NAME_PREFIX}IdTieB Artist`;

  // Dates deliberately NOT in plays-descending order (RANK1 sits at day 7, the
  // tie pair straddles day 1 and day 8) so a regression that ranked by
  // `starts_on` instead of `plays` fails the plays-desc assertions below
  // rather than accidentally matching by coincidence.
  const DAY = {
    tieEarlier: isoDate(1),
    rank2: isoDate(2),
    unrotated: isoDate(3),
    noPlays: isoDate(4),
    discogsOnly: isoDate(5),
    rank3: isoDate(6),
    rank1: isoDate(7),
    tieLater: isoDate(8),
    idTie: isoDate(9),
  };
  const WINDOW_FROM = isoDate(0);
  const WINDOW_TO = isoDate(30); // comfortably past every DAY.* offset above
  const PAST_GATED_STARTS_ON = isoDate(-10); // outside the default GET /concerts window

  let auth;
  let sql;
  let pastGatedConcertId;
  let idTieFirstConcertId;
  let idTieSecondConcertId;

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
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, starts_at, doors_at,
          headlining_artist_raw, headlining_artist_id, headlining_discogs_artist_id,
          title, supporting_artists_raw, ticket_url, image_url, price_min, price_max,
          age_restriction, status, removed_at, event_url, raw_data, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, '{}'::jsonb, now())
       RETURNING id`,
      [
        row.source,
        SOURCE_ID_PREFIX + key,
        venueId,
        row.starts_on,
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
    return inserted.id;
  };

  /** Artist + rotation-linked library release — a BS#1731-gated headliner. */
  const seedGatedArtist = async (name) => {
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [name]
    );
    const [libraryRow] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, (SELECT id FROM "${SCHEMA}".genres LIMIT 1), (SELECT id FROM "${SCHEMA}".format LIMIT 1), $2, 1)
       RETURNING id`,
      [artist.id, `${name} LP`]
    );
    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H')`, [libraryRow.id]);
    return artist.id;
  };

  const seedPlays = async (artistId, plays) => {
    await sql.unsafe(`INSERT INTO "${SCHEMA}".artist_station_plays (artist_id, plays) VALUES ($1, $2)`, [
      artistId,
      plays,
    ]);
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".artist_station_plays WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name LIKE $1)`,
      [`${ARTIST_NAME_PREFIX}%`]
    );
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".rotation WHERE album_id IN (SELECT id FROM "${SCHEMA}".library WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name LIKE $1))`,
      [`${ARTIST_NAME_PREFIX}%`]
    );
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".library WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name LIKE $1)`,
      [`${ARTIST_NAME_PREFIX}%`]
    );
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name LIKE $1`, [`${ARTIST_NAME_PREFIX}%`]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup(); // idempotent across re-runs (shared schema, --runInBand)

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1756 Probe Room', 'Carrboro', 'NC', '300 E Main St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    const venueId = venue.id;

    const rank1ArtistId = await seedGatedArtist(RANK1_ARTIST_NAME);
    const rank2ArtistId = await seedGatedArtist(RANK2_ARTIST_NAME);
    const rank3ArtistId = await seedGatedArtist(RANK3_ARTIST_NAME);
    const tieEarlierArtistId = await seedGatedArtist(TIE_EARLIER_ARTIST_NAME);
    const tieLaterArtistId = await seedGatedArtist(TIE_LATER_ARTIST_NAME);
    // Gated (rotation-linked), but deliberately given NO artist_station_plays
    // row — the NULL-plays case, which must rank LAST among the gated set.
    const noPlaysArtistId = await seedGatedArtist(NO_PLAYS_ARTIST_NAME);
    // Resolved headliner with no rotation-linked release: NOT gated.
    const [unrotatedArtist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [UNROTATED_ARTIST_NAME]
    );
    // Gated + plays, but its concert is in the PAST — the by-id
    // windowless+today-guard case (Fix #2).
    const pastGatedArtistId = await seedGatedArtist(PAST_GATED_ARTIST_NAME);
    // Two gated artists with EQUAL plays for the id-only tie-break case (Fix #3).
    const idTieArtistAId = await seedGatedArtist(ID_TIE_ARTIST_A_NAME);
    const idTieArtistBId = await seedGatedArtist(ID_TIE_ARTIST_B_NAME);

    await seedPlays(rank1ArtistId, 500);
    await seedPlays(rank2ArtistId, 300);
    await seedPlays(rank3ArtistId, 150);
    await seedPlays(tieEarlierArtistId, 100);
    await seedPlays(tieLaterArtistId, 100);
    // noPlaysArtistId intentionally gets no artist_station_plays row.
    await seedPlays(pastGatedArtistId, 200);
    await seedPlays(idTieArtistAId, 250);
    await seedPlays(idTieArtistBId, 250);

    await insertConcert(venueId, 'rank1', {
      starts_on: DAY.rank1,
      headlining_artist_raw: RANK1_ARTIST_NAME,
      headlining_artist_id: rank1ArtistId,
    });
    await insertConcert(venueId, 'rank2', {
      starts_on: DAY.rank2,
      headlining_artist_raw: RANK2_ARTIST_NAME,
      headlining_artist_id: rank2ArtistId,
    });
    await insertConcert(venueId, 'rank3', {
      starts_on: DAY.rank3,
      headlining_artist_raw: RANK3_ARTIST_NAME,
      headlining_artist_id: rank3ArtistId,
    });
    await insertConcert(venueId, 'tie-earlier', {
      starts_on: DAY.tieEarlier,
      headlining_artist_raw: TIE_EARLIER_ARTIST_NAME,
      headlining_artist_id: tieEarlierArtistId,
    });
    await insertConcert(venueId, 'tie-later', {
      starts_on: DAY.tieLater,
      headlining_artist_raw: TIE_LATER_ARTIST_NAME,
      headlining_artist_id: tieLaterArtistId,
    });
    await insertConcert(venueId, 'no-plays', {
      starts_on: DAY.noPlays,
      headlining_artist_raw: NO_PLAYS_ARTIST_NAME,
      headlining_artist_id: noPlaysArtistId,
    });
    await insertConcert(venueId, 'unrotated', {
      starts_on: DAY.unrotated,
      headlining_artist_raw: UNROTATED_ARTIST_NAME,
      headlining_artist_id: unrotatedArtist.id,
    });
    await insertConcert(venueId, 'discogs-only', {
      starts_on: DAY.discogsOnly,
      headlining_artist_raw: DISCOGS_ONLY_ARTIST_RAW,
      headlining_discogs_artist_id: DISCOGS_ONLY_ARTIST_DISCOGS_ID,
    });
    pastGatedConcertId = await insertConcert(venueId, 'past-gated', {
      starts_on: PAST_GATED_STARTS_ON,
      headlining_artist_raw: PAST_GATED_ARTIST_NAME,
      headlining_artist_id: pastGatedArtistId,
    });
    // Same starts_on for both — plays are also equal (250/250), so only the
    // final `id ASC` tie-break clause can order these two.
    idTieFirstConcertId = await insertConcert(venueId, 'id-tie-a', {
      starts_on: DAY.idTie,
      headlining_artist_raw: ID_TIE_ARTIST_A_NAME,
      headlining_artist_id: idTieArtistAId,
    });
    idTieSecondConcertId = await insertConcert(venueId, 'id-tie-b', {
      starts_on: DAY.idTie,
      headlining_artist_raw: ID_TIE_ARTIST_B_NAME,
      headlining_artist_id: idTieArtistBId,
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  /** Concerts from a response body that belong to this spec's seed. */
  const seeded = (body) => body.concerts.filter((c) => c.venue.slug === VENUE_SLUG);
  const findByRaw = (body, raw) => seeded(body).find((c) => c.headlining_artist_raw === raw);

  it('ranks the gated set by plays descending', async () => {
    // Absolute rank values are NOT asserted here: the rank domain is GLOBAL
    // (every upcoming gated concert in the DB, not just this spec's venue —
    // see the describe-level doc), so an unrelated gated concert elsewhere in
    // the CI clone could insert gaps above these. Only the RELATIVE order
    // among the seeded set is guaranteed by the SQL.
    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(res.status).toBe(200);
    const rank1 = findByRaw(res.body, RANK1_ARTIST_NAME).station_recommended_rank;
    const rank2 = findByRaw(res.body, RANK2_ARTIST_NAME).station_recommended_rank;
    const rank3 = findByRaw(res.body, RANK3_ARTIST_NAME).station_recommended_rank;
    expect(rank1).not.toBeNull();
    expect(rank2).not.toBeNull();
    expect(rank3).not.toBeNull();
    expect(rank1).toBeLessThan(rank2);
    expect(rank2).toBeLessThan(rank3);
  });

  it('sorts a gated headliner with no artist_station_plays row LAST among the gated set', async () => {
    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(res.status).toBe(200);
    const noPlays = findByRaw(res.body, NO_PLAYS_ARTIST_NAME);
    expect(noPlays).toBeDefined();
    expect(noPlays.station_recommended).toBe(true); // gated...
    expect(noPlays.station_recommended_rank).not.toBeNull();
    // ...but ranks below (a strictly larger rank number than) every
    // positive-plays gated headliner seeded by this spec, including the
    // equal-plays id-tie pair (Fix #3) — a higher rank NUMBER here means a
    // WORSE position, since rank 1 is best.
    const positivePlaysRanks = [
      RANK1_ARTIST_NAME,
      RANK2_ARTIST_NAME,
      RANK3_ARTIST_NAME,
      TIE_EARLIER_ARTIST_NAME,
      TIE_LATER_ARTIST_NAME,
      ID_TIE_ARTIST_A_NAME,
      ID_TIE_ARTIST_B_NAME,
    ].map((name) => findByRaw(res.body, name).station_recommended_rank);
    for (const rank of positivePlaysRanks) {
      expect(rank).not.toBeNull();
      expect(noPlays.station_recommended_rank).toBeGreaterThan(rank);
    }
  });

  it('breaks an equal-plays tie by earlier starts_on ranking lower', async () => {
    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(res.status).toBe(200);
    const earlier = findByRaw(res.body, TIE_EARLIER_ARTIST_NAME);
    const later = findByRaw(res.body, TIE_LATER_ARTIST_NAME);
    expect(earlier.station_recommended_rank).not.toBeNull();
    expect(later.station_recommended_rank).not.toBeNull();
    expect(earlier.station_recommended_rank).toBeLessThan(later.station_recommended_rank);
  });

  it('emits null station_recommended_rank for a non-gated headliner (resolved, unrotated)', async () => {
    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(res.status).toBe(200);
    const unrotated = findByRaw(res.body, UNROTATED_ARTIST_NAME);
    expect(unrotated).toBeDefined();
    expect(unrotated.station_recommended).toBe(false);
    expect(unrotated.station_recommended_rank).toBeNull();
  });

  it('emits null station_recommended_rank for a Discogs-only headliner', async () => {
    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(res.status).toBe(200);
    const discogsOnly = findByRaw(res.body, DISCOGS_ONLY_ARTIST_RAW);
    expect(discogsOnly).toBeDefined();
    expect(discogsOnly.headlining_artist_id).toBeNull();
    expect(discogsOnly.station_recommended_rank).toBeNull();
  });

  it('leaves the rank domain unbounded by the request `to` (rank reflects the FULL gated window, not the response subset)', async () => {
    // The property under test: narrowing `to` to exclude RANK1 must NOT
    // promote RANK2. Prove it by comparing RANK2's rank across two requests —
    // the full window and a window narrowed to drop RANK1 (day 7) and
    // TIE_LATER (day 8) from the response outright — and asserting RANK2's
    // rank is IDENTICAL in both. If the rank domain wrongly picked up the
    // request's `to` bound, RANK2 (the highest-plays headliner remaining once
    // RANK1 drops out of a wrongly-narrowed domain) would shift to the
    // minimum rank instead of staying put.
    const full = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(full.status).toBe(200);
    const narrowed = await auth.get('/concerts').query({ from: WINDOW_FROM, to: DAY.rank3, limit: 100 });
    expect(narrowed.status).toBe(200);

    expect(seeded(narrowed.body).find((c) => c.headlining_artist_raw === RANK1_ARTIST_NAME)).toBeUndefined();
    expect(seeded(narrowed.body).find((c) => c.headlining_artist_raw === TIE_LATER_ARTIST_NAME)).toBeUndefined();

    const rank2Full = findByRaw(full.body, RANK2_ARTIST_NAME).station_recommended_rank;
    const rank2Narrowed = findByRaw(narrowed.body, RANK2_ARTIST_NAME).station_recommended_rank;
    expect(rank2Full).not.toBeNull();
    expect(rank2Narrowed).toBe(rank2Full);
  });

  it('leaves the rank domain unaffected by `curated`', async () => {
    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, curated: true, limit: 100 });
    expect(res.status).toBe(200);
    const rank1 = findByRaw(res.body, RANK1_ARTIST_NAME).station_recommended_rank;
    const rank2 = findByRaw(res.body, RANK2_ARTIST_NAME).station_recommended_rank;
    const noPlays = findByRaw(res.body, NO_PLAYS_ARTIST_NAME).station_recommended_rank;
    expect(rank1).not.toBeNull();
    expect(rank2).not.toBeNull();
    expect(noPlays).not.toBeNull();
    expect(rank1).toBeLessThan(rank2);
    expect(rank2).toBeLessThan(noPlays);
  });

  it('holds a stable rank across pagination — identical whether fetched on one page or split across many (the BS#1756 load-bearing property)', async () => {
    // The naive bug this guards against: a `rank() OVER (...)` scoped to the
    // CURRENT PAGE (i.e. placed on the paginated query itself, after
    // LIMIT/OFFSET) would silently re-number 1..N on every page and still pass
    // a single-page test. Forcing `limit: 2` against the 10 in-window seeded
    // concerts spans at least 5 pages, so the gated set is guaranteed to
    // straddle several. (The spec seeds 12 concerts total, but the
    // past-gated one — Fix #2 — sits outside [WINDOW_FROM, WINDOW_TO] and is
    // correctly excluded from every page here.)
    const reference = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(reference.status).toBe(200);
    const referenceRanks = new Map(
      seeded(reference.body).map((c) => [c.headlining_artist_raw, c.station_recommended_rank])
    );
    // Sanity: this test only proves something if our own gated set is actually
    // present with real (non-null) ranks, and RANK1 (highest plays) actually
    // outranks TIE_LATER (a lower-plays tie member) — relative, not absolute,
    // since the rank domain is global (see the describe-level doc).
    expect(referenceRanks.get(RANK1_ARTIST_NAME)).not.toBeNull();
    expect(referenceRanks.get(TIE_LATER_ARTIST_NAME)).not.toBeNull();
    expect(referenceRanks.get(RANK1_ARTIST_NAME)).toBeLessThan(referenceRanks.get(TIE_LATER_ARTIST_NAME));

    const paginatedRanks = new Map();
    let page = 1;
    let hasMore = true;
    let pagesFetched = 0;
    const MAX_PAGES = 50; // generous safety cap — real total is small (§ WINDOW_TO)
    while (hasMore) {
      if (pagesFetched >= MAX_PAGES) {
        throw new Error(`station_recommended_rank pagination probe exceeded ${MAX_PAGES} pages — aborting`);
      }
      // eslint-disable-next-line no-await-in-loop -- sequential pagination walk
      const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 2, page });
      expect(res.status).toBe(200);
      for (const c of seeded(res.body)) {
        paginatedRanks.set(c.headlining_artist_raw, c.station_recommended_rank);
      }
      hasMore = res.body.pagination.hasMore;
      page += 1;
      pagesFetched += 1;
    }
    // Genuinely spans multiple pages for OUR OWN concerts: 10 in-window
    // seeded rows at limit 2 cannot fit on one page.
    expect(pagesFetched).toBeGreaterThan(1);

    for (const [raw, rank] of referenceRanks) {
      expect(paginatedRanks.get(raw)).toBe(rank);
    }
  });

  it('agrees between GET /concerts and GET /concerts/:id for an upcoming gated concert', async () => {
    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    const rank1 = findByRaw(res.body, RANK1_ARTIST_NAME);
    expect(rank1.station_recommended_rank).not.toBeNull();

    const byId = await auth.get(`/concerts/${rank1.id}`);
    expect(byId.status).toBe(200);
    // The by-id read recomputes the same rank subquery against venue-local
    // TODAY rather than the list's `from` — for an UPCOMING concert both
    // bound the same "today forward" domain, so the two must agree exactly.
    expect(byId.body.station_recommended_rank).toBe(rank1.station_recommended_rank);
  });

  it('returns a null station_recommended_rank by id for a PAST gated concert, even though station_recommended stays true', async () => {
    // GET /concerts/:id is deliberately WINDOWLESS (no `starts_on` bound), so
    // a past, tombstone-free, gated concert still comes back — but the rank
    // field's own CASE guard re-tests `starts_on >= today` for THIS row, and
    // a past `starts_on` fails that regardless of the query's lack of a
    // window. `station_recommended` is a separate EXISTS with no date
    // component, so it stays true. A past concert is excluded from the
    // default GET /concerts window entirely, so it can only be reached here
    // by id (see the describe-level doc's "windowless+today-guard" note).
    const byId = await auth.get(`/concerts/${pastGatedConcertId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.station_recommended).toBe(true);
    expect(byId.body.station_recommended_rank).toBeNull();
  });

  it('breaks an equal-plays, equal-starts_on tie by lower concert id ranking first', async () => {
    // ID_TIE_ARTIST_A and ID_TIE_ARTIST_B share identical plays (250/250) AND
    // an identical starts_on (DAY.idTie), so neither the plays-descending nor
    // the starts_on-ascending clause can order them — only the rank
    // subquery's final `x."id" < concerts.id` clause can. `idTieFirstConcertId`
    // and `idTieSecondConcertId` are captured from the seed inserts in
    // creation order, so the first is guaranteed the lower serial id.
    expect(idTieFirstConcertId).toBeLessThan(idTieSecondConcertId);

    const res = await auth.get('/concerts').query({ from: WINDOW_FROM, to: WINDOW_TO, limit: 100 });
    expect(res.status).toBe(200);
    const first = seeded(res.body).find((c) => c.id === idTieFirstConcertId);
    const second = seeded(res.body).find((c) => c.id === idTieSecondConcertId);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.station_recommended_rank).not.toBeNull();
    expect(second.station_recommended_rank).not.toBeNull();
    expect(first.station_recommended_rank).toBeLessThan(second.station_recommended_rank);
  });
});
