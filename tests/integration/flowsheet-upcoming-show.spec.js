/**
 * BS#1607 — per-playcut `upcoming_show` enrichment on the V2 flowsheet feed
 * (touring-events Phase 3).
 *
 * Postgres-backed: seeds a show, flowsheet track rows linked to library
 * albums (whose artists come from the fixed-ID seed fixture), and a set of
 * `concerts` rows keyed by a `bs1607:` source_id prefix. Cleanup is a prefix
 * DELETE so nothing leaks across the shared-schema `--runInBand` suite.
 *
 * Pins the load-bearing server contract:
 *   - a track whose resolved artist (album_id → library.artist_id) matches a
 *     curated, non-tombstoned, upcoming concert carries that concert inline as
 *     `upcoming_show`, with the full `Concert` wire shape and no internal
 *     ingestion columns;
 *   - the SOONEST of an artist's several upcoming dates wins;
 *   - no match, an unresolved (free-form / null album_id) artist with no
 *     matching concert, and removed/past concerts all leave `upcoming_show`
 *     absent (parity: the row is byte-identical to its pre-1607 shape);
 *   - the lookup is BATCHED — a page whose N track rows all match still hits
 *     the `concerts` table a bounded, N-independent number of times (proves no
 *     per-row query).
 *
 * BS#1613 widens the match to a name arm alongside the id arm, also pinned here:
 *   - a FREE-TEXT play (null album_id, so no resolved artist_id) attaches a
 *     clean UNRESOLVED concert (headlining_artist_id null) by normalized name;
 *   - a billing-string concert raw (`Circle Jerks & Municipal Waste`) is an
 *     inert key — it does not attach to a single-artist play (`Circle Jerks`);
 *   - the name arm collapses two unresolved concerts whose raws normalize to
 *     the same key to the SOONEST date.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1607:';
const VENUE_SLUG = 'bs1607-probe-room';
const SHOW_NAME = 'BS#1607 upcoming-show probe';

// Fixed-ID seed fixture (dev_env/seed_db.sql): artist 1 (Built to Spill) owns
// library album 1; artist 2 (Ravyn Lenae) owns album 2; artist 3 (Jockstrap)
// owns album 3. Concerts are seeded against these artist ids.
const ARTIST_WITH_SHOW = 1;
const ALBUM_WITH_SHOW = 1;
const ARTIST_NO_SHOW = 2;
const ALBUM_NO_SHOW = 2;
const ARTIST_ONLY_PAST = 3;
const ALBUM_ONLY_PAST = 3;

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

/** YYYY-MM-DD for today + offsetDays, America/New_York (matches the feed's "today"). */
function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

const PAST = isoDate(-14);
const SOON = isoDate(7); // the soonest upcoming date for ARTIST_WITH_SHOW
const LATER = isoDate(21); // a later date for the same artist — must lose

// BS#1613 name-arm dates: two upcoming dates for one normalized name key, to
// prove the name arm also collapses to the soonest.
const NAME_SOON = isoDate(4);
const NAME_LATER = isoDate(25);

describe('V2 flowsheet upcoming_show enrichment (BS#1607)', () => {
  let sql;
  let venueId;
  let showId;
  let insertedTrackIds = [];

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
          removed_at, raw_data, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '{}'::jsonb, now())`,
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
      ]
    );
  };

  /** Insert one flowsheet track row, returning its id. */
  const seedTrack = async ({ albumId, artistName, playOrder }) => {
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (show_id, album_id, entry_type, artist_name, album_title, track_title, play_order, add_time, metadata_status)
       VALUES ($1, $2, 'track', $3, 'Probe Album', 'Probe Track', $4, now(), 'enriched_match')
       RETURNING id`,
      [showId, albumId, artistName, playOrder]
    );
    return inserted.id;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    if (insertedTrackIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedTrackIds]);
    }
    if (showId) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE id = $1`, [showId]);
    }
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
  };

  beforeAll(async () => {
    sql = makeSql();
    await cleanup();

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1607 Probe Room', 'Carrboro', 'NC', '300 E Main St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    const [show] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".shows (show_name, start_time) VALUES ($1, now()) RETURNING id`,
      [SHOW_NAME]
    );
    showId = show.id;

    // ARTIST_WITH_SHOW: two upcoming dates — the soonest must win — plus a
    // later date, a tombstoned row, and a past row that must all be ignored.
    await seedConcert({
      key: 'soon',
      venue_id: venueId,
      starts_on: SOON,
      starts_at: `${SOON}T23:30:00.000Z`,
      doors_at: `${SOON}T22:30:00.000Z`,
      headlining_artist_raw: 'Built to Spill',
      headlining_artist_id: ARTIST_WITH_SHOW,
      supporting_artists: ['Opener A'],
      ticket_url: 'https://example.com/tickets/bs1607',
      image_url: 'https://example.com/img/bs1607.jpg',
      price_min: '20.00',
      price_max: '24.00',
      age_restriction: 'All Ages',
    });
    await seedConcert({
      key: 'later',
      venue_id: venueId,
      starts_on: LATER,
      headlining_artist_raw: 'Built to Spill',
      headlining_artist_id: ARTIST_WITH_SHOW,
    });
    await seedConcert({
      key: 'removed',
      venue_id: venueId,
      starts_on: SOON,
      headlining_artist_raw: 'Built to Spill',
      headlining_artist_id: ARTIST_WITH_SHOW,
      removed_at: new Date().toISOString(),
    });

    // ARTIST_ONLY_PAST: has a concert, but it already happened — excluded.
    await seedConcert({
      key: 'past',
      venue_id: venueId,
      starts_on: PAST,
      headlining_artist_raw: 'Jockstrap',
      headlining_artist_id: ARTIST_ONLY_PAST,
    });

    // BS#1613 name-arm fixtures — all UNRESOLVED (headlining_artist_id null),
    // so they can't be reached by the id arm; the name arm is the only path.
    // A clean single name absent from our catalog (the recall #1613 adds).
    await seedConcert({
      key: 'freetext-clean',
      venue_id: venueId,
      starts_on: SOON,
      headlining_artist_raw: 'Wishy',
    });
    // A billing string — normalizes to its entire self, an inert map key.
    await seedConcert({
      key: 'billing',
      venue_id: venueId,
      starts_on: SOON,
      headlining_artist_raw: 'Circle Jerks & Municipal Waste',
    });
    // Two dates whose raws normalize to the same key ('tubs') — soonest wins.
    await seedConcert({
      key: 'name-soon',
      venue_id: venueId,
      starts_on: NAME_SOON,
      headlining_artist_raw: 'The Tubs',
    });
    await seedConcert({
      key: 'name-later',
      venue_id: venueId,
      starts_on: NAME_LATER,
      headlining_artist_raw: 'THE TUBS',
    });

    // Track rows: one matching artist, one with an artist that has no upcoming
    // date, one whose artist only has a past date, and one free-form (null
    // album_id → unresolved artist) with no matching concert.
    const t1 = await seedTrack({ albumId: ALBUM_WITH_SHOW, artistName: 'Built to Spill', playOrder: 1 });
    const t2 = await seedTrack({ albumId: ALBUM_NO_SHOW, artistName: 'Ravyn Lenae', playOrder: 2 });
    const t3 = await seedTrack({ albumId: ALBUM_ONLY_PAST, artistName: 'Jockstrap', playOrder: 3 });
    const t4 = await seedTrack({ albumId: null, artistName: 'Some Free-Form Act', playOrder: 4 });
    // BS#1613 free-text plays (null album_id → null artist_id): match by name.
    const t5 = await seedTrack({ albumId: null, artistName: 'Wishy', playOrder: 5 });
    const t6 = await seedTrack({ albumId: null, artistName: 'Circle Jerks', playOrder: 6 });
    const t7 = await seedTrack({ albumId: null, artistName: 'The Tubs', playOrder: 7 });
    insertedTrackIds = [t1, t2, t3, t4, t5, t6, t7];
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  /** Fetch this spec's seeded track rows via the V2 range read. */
  const fetchSeededTracks = async () => {
    const startId = Math.min(...insertedTrackIds);
    const endId = Math.max(...insertedTrackIds);
    const res = await request.get('/flowsheet').query({ start_id: startId, end_id: endId });
    expect(res.status).toBe(200);
    const bySeed = new Set(insertedTrackIds);
    return res.body.filter((e) => bySeed.has(e.id));
  };

  it('attaches the soonest curated upcoming concert to a matching track', async () => {
    const tracks = await fetchSeededTracks();
    const matched = tracks.find((t) => t.album_id === ALBUM_WITH_SHOW);
    expect(matched).toBeDefined();
    expect(matched.upcoming_show).toBeDefined();
    expect(matched.upcoming_show).toMatchObject({
      starts_on: SOON, // the soonest date, not LATER
      headlining_artist_id: ARTIST_WITH_SHOW,
      headlining_artist_raw: 'Built to Spill',
      supporting_artists_raw: ['Opener A'],
      ticket_url: 'https://example.com/tickets/bs1607',
      price_min: 20,
      price_max: 24,
      status: 'on_sale',
      venue: { slug: VENUE_SLUG, name: 'BS1607 Probe Room', city: 'Carrboro' },
    });
  });

  it('serves the full Concert wire shape with no internal ingestion columns', async () => {
    const tracks = await fetchSeededTracks();
    const show = tracks.find((t) => t.album_id === ALBUM_WITH_SHOW).upcoming_show;
    for (const internal of ['source', 'source_id', 'raw_data', 'scraped_at', 'first_scraped_at', 'removed_at']) {
      expect(show).not.toHaveProperty(internal);
      expect(show.venue).not.toHaveProperty(internal);
    }
  });

  it('leaves upcoming_show absent when the artist has no upcoming date', async () => {
    const tracks = await fetchSeededTracks();
    const noShow = tracks.find((t) => t.album_id === ALBUM_NO_SHOW);
    expect(noShow).toBeDefined();
    expect(noShow).not.toHaveProperty('upcoming_show');
  });

  it("leaves upcoming_show absent when the artist's only concert is in the past", async () => {
    const tracks = await fetchSeededTracks();
    const pastOnly = tracks.find((t) => t.album_id === ALBUM_ONLY_PAST);
    expect(pastOnly).toBeDefined();
    expect(pastOnly).not.toHaveProperty('upcoming_show');
  });

  it('leaves upcoming_show absent for a free-form track with no matching concert', async () => {
    const tracks = await fetchSeededTracks();
    // Several tracks now share a null album_id (the BS#1613 free-text plays), so
    // key on the artist name that has no concert.
    const freeForm = tracks.find((t) => t.album_id === null && t.artist_name === 'Some Free-Form Act');
    expect(freeForm).toBeDefined();
    expect(freeForm).not.toHaveProperty('upcoming_show');
  });

  // --- BS#1613 name arm ---

  it('attaches a clean unresolved concert to a free-text play by normalized name', async () => {
    const tracks = await fetchSeededTracks();
    const freeText = tracks.find((t) => t.album_id === null && t.artist_name === 'Wishy');
    expect(freeText).toBeDefined();
    expect(freeText.upcoming_show).toBeDefined();
    expect(freeText.upcoming_show).toMatchObject({
      starts_on: SOON,
      headlining_artist_raw: 'Wishy',
      headlining_artist_id: null, // unresolved — matched purely by name
      venue: { slug: VENUE_SLUG },
    });
  });

  it('does not attach a billing-string concert to a single-artist free-text play (inert key)', async () => {
    const tracks = await fetchSeededTracks();
    // The concert raw is 'Circle Jerks & Municipal Waste'; the play is
    // 'Circle Jerks'. The billing string normalizes to its entire self, so the
    // single-act play never equals it.
    const cj = tracks.find((t) => t.album_id === null && t.artist_name === 'Circle Jerks');
    expect(cj).toBeDefined();
    expect(cj).not.toHaveProperty('upcoming_show');
  });

  it('collapses two same-normalized-name unresolved concerts to the SOONEST', async () => {
    const tracks = await fetchSeededTracks();
    // 'The Tubs' and 'THE TUBS' both normalize to 'tubs'; only NAME_SOON rides.
    const tubs = tracks.find((t) => t.album_id === null && t.artist_name === 'The Tubs');
    expect(tubs).toBeDefined();
    expect(tubs.upcoming_show).toBeDefined();
    expect(tubs.upcoming_show.starts_on).toBe(NAME_SOON);
    expect(tubs.upcoming_show.starts_on).not.toBe(NAME_LATER);
  });

  it('never surfaces the tombstoned or later date for the matching artist', async () => {
    const tracks = await fetchSeededTracks();
    const show = tracks.find((t) => t.album_id === ALBUM_WITH_SHOW).upcoming_show;
    // Exactly one concert rides the playcut, and it is the soonest non-removed one.
    expect(show.starts_on).toBe(SOON);
    expect(show.starts_on).not.toBe(LATER);
  });

  /**
   * Batching proof (no per-row query): count how many times the `concerts`
   * table is scanned per feed read via `pg_stat_user_tables`, and show the
   * per-request delta does NOT grow with the number of matching rows on the
   * page. A per-row implementation scans `concerts` once per matching row (so
   * the delta tracks the match count); the batched implementation issues a
   * single lookup for the whole page, so the delta is a small constant.
   *
   * `pg_stat_user_tables` is updated asynchronously by the stats collector and
   * the backend serves the feed on its own connection pool, so a naive
   * before/after around one request races the flush. `settledScans` clears the
   * caller's stats snapshot and polls until the cumulative counter stops
   * moving, giving a stable reading; the assertion then compares a small-page
   * delta against a large-page delta rather than trusting an absolute count.
   */
  const settledScans = async () => {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sql.unsafe('SELECT pg_stat_clear_snapshot()');
      // eslint-disable-next-line no-await-in-loop
      const [row] = await sql.unsafe(
        `SELECT COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0) AS scans
           FROM pg_stat_user_tables
          WHERE schemaname = $1 AND relname = 'concerts'`,
        [SCHEMA]
      );
      const scans = Number(row ? row.scans : 0);
      if (scans === last) return scans; // two identical reads = flushed
      last = scans;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  };

  /** Raw cumulative concerts-scan counter (single read, snapshot cleared first). */
  const rawScans = async () => {
    await sql.unsafe('SELECT pg_stat_clear_snapshot()');
    const [row] = await sql.unsafe(
      `SELECT COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0) AS scans
         FROM pg_stat_user_tables
        WHERE schemaname = $1 AND relname = 'concerts'`,
      [SCHEMA]
    );
    return Number(row ? row.scans : 0);
  };

  /**
   * concerts-scan delta attributable to EXACTLY ONE feed read of this page.
   *
   * `pg_stat_user_tables` is flushed asynchronously by the stats collector, and
   * the backend serves the feed on its own connection pool, so the scan a feed
   * read performs is not always visible on the first poll. The naive
   * `after(settled) - before(settled)` around a single read can settle BEFORE
   * the read's scan flushes and report a spurious 0. Retrying the whole
   * before/read/after cycle is worse: each extra feed read adds scans that flush
   * into a later bracket, inflating the delta above the anti-N+1 ceiling.
   *
   * So we issue the feed read exactly ONCE, then poll the counter until it has
   * both advanced past `before` AND gone stable (two equal consecutive reads) —
   * capturing this single read's scans without absorbing any other. If it never
   * advances within the budget the delta stays 0 and the `>= 1` liveness
   * assertion fails honestly (rather than looping and issuing more reads).
   */
  const scanDeltaForOneFeedRead = async () => {
    const before = await settledScans();
    await fetchSeededTracks();

    let last = -1;
    let stableAdvanced = before;
    for (let i = 0; i < 40; i++) {
      const scans = await rawScans(); // eslint-disable-line no-await-in-loop
      if (scans > before && scans === last) {
        stableAdvanced = scans;
        break;
      }
      last = scans;
      await new Promise((r) => setTimeout(r, 100)); // eslint-disable-line no-await-in-loop
    }
    return stableAdvanced - before;
  };

  // The batched lookup scans `concerts` a small, bounded number of times per
  // feed read regardless of how many matching rows the page carries. A per-row
  // implementation would scan once per matching row, so with MANY_MATCHES rows
  // the delta would be >= MANY_MATCHES. We assert the delta stays well under
  // that count — the clean separation between "one batched query" (a handful of
  // scans) and "one query per row" (>= 9). An absolute bound is used rather
  // than a small-vs-large diff because a single query's scan count already
  // varies by 1-2 (index probe + heap access) run to run.
  const MANY_MATCHES = 8;
  const BATCHED_SCAN_CEILING = 5;

  it('batches the lookup: concerts-table scans do not grow with page match count', async () => {
    // Add many more matching tracks, all resolving to ARTIST_WITH_SHOW, so the
    // page has 1 + MANY_MATCHES matches. A per-row lookup would scan concerts
    // once per matching row.
    const extraIds = [];
    for (let i = 0; i < MANY_MATCHES; i++) {
      // eslint-disable-next-line no-await-in-loop
      const id = await seedTrack({ albumId: ALBUM_WITH_SHOW, artistName: 'Built to Spill', playOrder: 100 + i });
      extraIds.push(id);
    }
    insertedTrackIds.push(...extraIds);

    const largeDelta = await scanDeltaForOneFeedRead();

    // Liveness lower bound: the feed read must scan `concerts` at LEAST once,
    // else the enrichment is a no-op and the whole batching contract is vacuous
    // (a delta of 0 would silently pass a regression that stopped querying
    // concerts entirely). `scanDeltaForOneFeedRead` retries until it observes a
    // positive delta (absorbing the async stats-flush race), so `>= 1` is
    // reliable here, not flaky — see its doc comment for why the naive
    // before/after can spuriously read 0.
    expect(largeDelta).toBeGreaterThanOrEqual(1);
    // Upper bounds (anti-N+1): never one-scan-per-row — a per-row impl would
    // push this to >= 9.
    expect(largeDelta).toBeLessThanOrEqual(BATCHED_SCAN_CEILING);
    expect(largeDelta).toBeLessThan(1 + MANY_MATCHES);
  });

  /**
   * Conditional-GET freshness across `concerts` writes (BS#1607, migration
   * 0114). Because the V2 feed embeds `upcoming_show` from `concerts`, a
   * concerts write must advance the flowsheet watermark — otherwise a polling
   * client's `If-Modified-Since` would 304 against a page whose curated CTA has
   * changed (the stale-add case). The 0114 AFTER STATEMENT trigger on
   * `concerts` reuses `touch_flowsheet_watermark()` (from 0084), which bumps the
   * watermark to `GREATEST(now(), prev + 1s)` — strictly greater than the
   * pre-write value, so the subsequent conditional GET recomputes a fresh 200.
   */
  it('a concerts write advances the flowsheet watermark: conditional GET re-200s (migration 0114)', async () => {
    // Use this spec's seeded track range so the range read is non-empty (a
    // range that matches no rows 404s before the conditional-GET header lands).
    const startId = Math.min(...insertedTrackIds);
    const endId = Math.max(...insertedTrackIds);
    const getFeed = (ifModifiedSince) => {
      const req = request.get('/flowsheet').query({ start_id: startId, end_id: endId });
      return ifModifiedSince ? req.set('If-Modified-Since', ifModifiedSince) : req;
    };

    // Baseline: read the current effective Last-Modified for the feed.
    const baseline = await getFeed();
    expect(baseline.status).toBe(200);
    const lastModified = baseline.headers['last-modified'];
    expect(lastModified).toBeDefined();

    // Same watermark, no intervening write -> 304 (proves the baseline is a
    // real conditional-GET watermark, not an always-200 route).
    const unchanged = await getFeed(lastModified);
    expect(unchanged.status).toBe(304);

    // A concerts write fires the 0114 trigger and advances the watermark. Use
    // an UPDATE on an existing seeded row so the write is self-contained (no new
    // source_id to clean up); the AFTER STATEMENT trigger fires on UPDATE too.
    // Guard against same-second flooring in the conditional-GET comparison: the
    // trigger's `+1s` floor guarantees a whole-second advance, but poll a few
    // times so an unflushed read doesn't race the assertion.
    await sql.unsafe(`UPDATE "${SCHEMA}".concerts SET scraped_at = now() WHERE source_id = $1`, [
      `${SOURCE_ID_PREFIX}soon`,
    ]);

    let statusAfterWrite = 304;
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await getFeed(lastModified);
      statusAfterWrite = res.status;
      if (statusAfterWrite === 200) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(statusAfterWrite).toBe(200);
  });
});
