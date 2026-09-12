/**
 * BS#1607 — per-playcut `upcoming_show` enrichment on the V2 flowsheet feed
 * (on-tour Phase 3).
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

// BS#1613 RESOLVED name-arm probe: artist 6 (Bjork) with a scraped raw ('Björk',
// diacritic) that DIFFERS from the canonical catalog name ('Bjork'). A free-text
// play typed 'Bjork' can only attach if the name arm keys off the LEFT-JOINed
// canonical `artists.artist_name`, not the raw — so this fixture fails loudly if
// that join ever regresses (which the mocked unit tests can't catch).
const ARTIST_RESOLVED_NAME = 6;
const RESOLVED_CANONICAL_NAME = 'Bjork';
const RESOLVED_SCRAPED_RAW = 'Björk';
const RESOLVED_NAME_DATE = isoDate(6);

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

  /**
   * Clear the SERVER's per-process `upcoming_show` map cache (BS#1616). The cache
   * lives in the backend process, out of this out-of-process test's reach, so we
   * clear it through the dev/test-only `/internal/test/reset-upcoming-shows-cache`
   * endpoint (the CI-profile backend runs NODE_ENV=test, so the route exists).
   * Used to force a genuine cold feed read.
   */
  const resetUpcomingShowsCache = async () => {
    const res = await request.post('/internal/test/reset-upcoming-shows-cache');
    expect(res.status).toBe(204);
  };

  beforeAll(async () => {
    sql = makeSql();

    // BS#2194 option 3, taken alongside the growth comparison below (never
    // instead of it). Autovacuum and autoanalyze on `concerts` bump the same
    // database-wide scan counter the batching proof reads, and this spec's own
    // seed/cleanup churn on the table is exactly what arms them. Off for the
    // duration of this file, RESET in afterAll. Strictly reduces the noise; it
    // does NOT make the measurement sound — pooled application connections and
    // concurrent work still land in the counter, which is why the assertion is
    // a growth comparison rather than a bound on a magnitude.
    await sql.unsafe(`ALTER TABLE "${SCHEMA}".concerts SET (autovacuum_enabled = false)`);

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
    // A RESOLVED concert (headlining_artist_id set) whose scraped raw differs
    // from the canonical catalog name — exercises the real LEFT JOIN sourcing
    // the name-arm key off artists.artist_name.
    await seedConcert({
      key: 'resolved-name',
      venue_id: venueId,
      starts_on: RESOLVED_NAME_DATE,
      headlining_artist_raw: RESOLVED_SCRAPED_RAW,
      headlining_artist_id: ARTIST_RESOLVED_NAME,
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
    // Free-text play typed with the CANONICAL name of a resolved concert whose
    // scraped raw differs — must attach via the canonical name-arm key.
    const t8 = await seedTrack({ albumId: null, artistName: RESOLVED_CANONICAL_NAME, playOrder: 8 });
    insertedTrackIds = [t1, t2, t3, t4, t5, t6, t7, t8];

    // A prior spec file's /flowsheet read may have warmed the server's
    // upcoming_show map cache (BS#1616) before these concerts existed. Clear it
    // so the first read in this file rebuilds against the seeded fixtures rather
    // than serving a stale, concert-free map for the same ET `today` key.
    await resetUpcomingShowsCache();
  });

  afterAll(async () => {
    await cleanup();
    // Restore the table default (a no-op if the beforeAll SET never ran).
    await sql.unsafe(`ALTER TABLE "${SCHEMA}".concerts RESET (autovacuum_enabled)`);
    await sql.end();
  });

  /** One V2 range read over [startId, endId] — the raw page, unfiltered. */
  const fetchPage = async (startId, endId) => {
    const res = await request.get('/flowsheet').query({ start_id: startId, end_id: endId });
    expect(res.status).toBe(200);
    return res.body;
  };

  /** Fetch this spec's seeded track rows via the V2 range read. */
  const fetchSeededTracks = async () => {
    const body = await fetchPage(Math.min(...insertedTrackIds), Math.max(...insertedTrackIds));
    const bySeed = new Set(insertedTrackIds);
    return body.filter((e) => bySeed.has(e.id));
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

  it('attaches a RESOLVED concert to a free-text play via the LEFT-JOINed canonical name (not the raw)', async () => {
    const tracks = await fetchSeededTracks();
    // The play is typed with the canonical catalog name 'Bjork'; the resolved
    // concert's scraped raw is 'Björk' (diacritic). Matching proves the name-arm
    // key is sourced from artists.artist_name via the LEFT JOIN — if that join
    // regressed, the key would fall back to the raw 'Björk' and this would miss.
    const bjork = tracks.find((t) => t.album_id === null && t.artist_name === RESOLVED_CANONICAL_NAME);
    expect(bjork).toBeDefined();
    expect(bjork.upcoming_show).toBeDefined();
    expect(bjork.upcoming_show).toMatchObject({
      starts_on: RESOLVED_NAME_DATE,
      headlining_artist_id: ARTIST_RESOLVED_NAME, // the resolved concert
      headlining_artist_raw: RESOLVED_SCRAPED_RAW, // whose raw differs from canonical
      venue: { slug: VENUE_SLUG },
    });
  });

  it('never surfaces the tombstoned or later date for the matching artist', async () => {
    const tracks = await fetchSeededTracks();
    const show = tracks.find((t) => t.album_id === ALBUM_WITH_SHOW).upcoming_show;
    // Exactly one concert rides the playcut, and it is the soonest non-removed one.
    expect(show.starts_on).toBe(SOON);
    expect(show.starts_on).not.toBe(LATER);
  });

  /**
   * Batching proof (no per-row query). The contract — the one the ticket and
   * project #32's perf posture require — is that the `concerts` cost of a feed
   * read does NOT grow with the number of matching rows on the page: a per-row
   * implementation scans `concerts` once per matching row, the batched one
   * (BS#1616 `getUpcomingShowsMaps`) issues a fixed two queries for the whole
   * page. We prove it by counting scans of the `concerts` table in
   * `pg_stat_user_tables` across two brackets whose ONLY difference is
   * EXTRA_MATCHES additional matching rows, and asserting the growth between
   * them stays far below one scan per added row.
   *
   * WHY A GROWTH COMPARISON AND NOT AN ABSOLUTE CEILING (BS#2194). The
   * `pg_stat_user_tables` counter is per-table and DATABASE-WIDE. It is scoped
   * to neither the connection, the request, nor the test, so autovacuum, the
   * app's own pooled connections and any concurrent work all land in whichever
   * bracket happens to be open — no amount of care about WHEN the counter is
   * read can recover WHOSE work it counted. The earlier form of this test put an
   * absolute ceiling on a single bracket and went red three times on ambient
   * scans it had no way to attribute: deltas of 6 (#1661), 10 (CI) and 36
   * (local) against a ceiling of 7, and on two of those three the anti-N+1
   * property the test exists to defend was provably intact. Raising the ceiling
   * was #1661's fix and does not survive a 36 — past `1 + match count` the
   * bound stops proving anything at all, so there is no number that both
   * tolerates the observed noise and keeps the contract. A growth comparison
   * survives the leak instead of trying to bound it: ambient scans land in both
   * brackets and cancel in the difference. What that gives up is stated on the
   * ticket and accepted: it says nothing about the cost of ONE read, so a
   * batched lookup that became 3x more expensive at a constant match count
   * still passes. And the cancellation is statistical — under heavy concurrent
   * writes to `concerts` the residual can exceed the signal (measured here:
   * ~2,400 ambient scans per bracket cancelled down to 156; a no-sleep hammer
   * loop left 416 against a 96-scan signal). It stays GREEN in both cases,
   * which is the property this ticket is after; what degrades under load is
   * detection, not the flake. If a regression ever does slip through, option 1
   * on the ticket — `pg_stat_statements` keyed by queryid — is the
   * per-statement counter that needs none of this.
   *
   * Attribution is only half of it. The counter is also published LATE, on a
   * schedule this test does not control, and the second half of the fix is the
   * flush barrier described below — without which a bracket measures somebody
   * else's work no matter how the assertion is phrased.
   */

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

  // `pg_stat_user_tables` is flushed asynchronously PER BACKEND, and a pooled
  // application connection flushes on its own schedule: at the end of a
  // transaction once PGSTAT_MIN_INTERVAL (1s) has passed since its last flush,
  // and otherwise only after Postgres's ~10s idle-stats timeout. That second
  // number is the one that matters and it is an order of magnitude longer than
  // this file used to assume. Measured on this harness (BS#2194): a burst of
  // feed reads on an idle pooled connection was STILL invisible to another
  // session 8s later and only surfaced at ~14s — until then the counter sits on
  // a perfectly flat plateau that any "has it stopped moving?" poll reads as
  // drained. That is why a bracket can measure a fraction of its own work and
  // the remainder shows up in a later one, and it is not fixable by polling
  // longer at a tolerable cost. See `flushBarrier` below, which makes the flush
  // happen on demand instead of waiting for it.
  //
  // Two helpers read the cumulative counter drained to a sustained quiescent
  // value — a run of consecutive equal reads — which is still needed to absorb
  // the sub-second jitter after a barrier has published the pending stats.
  const STABLE = 6; // consecutive equal reads ⇒ the flush has fully settled
  const GAP_MS = 200; // STABLE × GAP_MS = 1.2s of stillness after a barrier
  const MAX_POLLS = 80;

  /** Drained counter with no advancement requirement (a quiescent baseline). */
  const quiescedScans = async () => {
    let last = -1;
    let run = 0;
    for (let i = 0; i < MAX_POLLS; i++) {
      const scans = await rawScans(); // eslint-disable-line no-await-in-loop
      if (scans === last) run += 1;
      else {
        last = scans;
        run = 1;
      }
      if (run >= STABLE) return scans;
      await new Promise((r) => setTimeout(r, GAP_MS)); // eslint-disable-line no-await-in-loop
    }
    return last;
  };

  /**
   * Drained counter AFTER it has advanced past `baseline`. A plain quiesce can
   * latch onto a PRE-flush plateau (counter still at `baseline`) and declare
   * "drained" before the bracket's increments ever appear — they then surface in
   * a later bracket. Requiring an advance first rules that out. Note this is a
   * guard, not the mechanism: it is `flushBarrier` that makes the advance happen
   * promptly, and without one this helper happily returns `baseline + 1` while
   * the other 31 scans sit unpublished (that is measured, not hypothetical —
   * see the flush model above). If the counter never advances at all (a
   * regression that stopped querying `concerts`), it exhausts the budget and
   * returns `baseline`, so the caller's `>= 1` liveness assertion fails
   * honestly.
   */
  const drainedScansAbove = async (baseline) => {
    let last = -1;
    let run = 0;
    for (let i = 0; i < MAX_POLLS; i++) {
      const scans = await rawScans(); // eslint-disable-line no-await-in-loop
      if (scans > baseline && scans === last) run += 1;
      else {
        last = scans;
        run = 1;
      }
      if (scans > baseline && run >= STABLE) return scans;
      await new Promise((r) => setTimeout(r, GAP_MS)); // eslint-disable-line no-await-in-loop
    }
    return last;
  };

  // FLUSH BARRIER — how a bracket boundary is made to mean something.
  //
  // Per the flush model above, the work a bracket did is invisible until the
  // pooled backend that did it flushes, which on an idle connection is ~10s
  // away. Rather than pay that at all four boundaries, force it: wait out the
  // 1s PGSTAT_MIN_INTERVAL floor, then fire a CONCURRENT burst of cheap
  // DB-backed requests wider than the app's connection pool (postgres-js
  // defaults to max 10; the feed reads above occupy only two or three of them).
  // Every pooled backend then ends a transaction more than a second after its
  // last flush and publishes everything it had been holding.
  //
  // The burst hits `/flowsheet/djs-on-air` specifically because it reads the DB
  // (so it ends a transaction and flushes) while touching NOTHING this test
  // measures — no `concerts` query anywhere in `getOnAirDJs`. A barrier that
  // read the feed instead would work too, but it would add its own `concerts`
  // scans to the bracket AND leave them pending for the next one, and that
  // deferred batch does not always land in the same bracket: measured against
  // the per-row implementation, one run lost exactly one barrier's worth (96
  // scans) out of a 256-scan signal. Keeping the barrier off the measured table
  // removes the quantum instead of hoping it cancels.
  const FLUSH_FANOUT = 12;
  const FLUSH_SETTLE_MS = 1200;

  /** Publish every pooled backend's pending table stats. Touches no `concerts` row. */
  const flushBarrier = async () => {
    await new Promise((r) => setTimeout(r, FLUSH_SETTLE_MS));
    await Promise.all(
      Array.from({ length: FLUSH_FANOUT }, async () => {
        const res = await request.get('/flowsheet/djs-on-air');
        expect(res.status).toBe(200);
      })
    );
  };

  // BRACKET GEOMETRY. The FEW bracket reads the beforeAll page; the MANY
  // bracket reads that SAME page plus EXTRA_MATCHES more track rows, every one
  // of them resolving to ARTIST_WITH_SHOW. The two brackets therefore differ by
  // exactly EXTRA_MATCHES matching rows and by nothing else, which is what lets
  // their difference be read as "cost per added matching row".
  //
  // Each bracket does COLD_READS cold reads rather than one, and that is the
  // whole trick for noise robustness: the per-row SIGNAL scales with the read
  // count (COLD_READS x EXTRA_MATCHES scans) while ambient NOISE does not. Noise
  // is a function of wall-clock time, and a bracket's wall clock is dominated by
  // its flush barrier and drain (~2.5s), not by the ~20ms feed reads inside it —
  // so eight reads buy 8x the separation for a few hundred milliseconds. The
  // extra rows are free on the batched side too: `getUpcomingShowsMaps` scans
  // the upcoming-concerts set, whose size is independent of the page. BOTH
  // numbers are therefore cheap to raise and should be raised, not lowered, if
  // this ever proves marginal again — the whole point of the geometry is that
  // buying separation costs milliseconds.
  const EXTRA_MATCHES = 32;
  const COLD_READS = 8;

  // THE THRESHOLD, from both sides. A per-row implementation scans `concerts`
  // at least once per matching row per read, so between the two brackets it
  // grows by at least COLD_READS x EXTRA_MATCHES = 256. The batched
  // implementation grows by ~0 (its two page-independent queries cost the same
  // either way). We fail at HALF the per-row growth, 128:
  //   - detection: a genuine per-row regression overshoots the bound 2x, and so
  //     does any half-way regression — one query per two rows would land
  //     exactly ON it, so anything at or above "half an N+1" is caught;
  //   - noise: it tolerates 127 scans of ASYMMETRIC ambient leakage, i.e. one
  //     bracket absorbing all of it and the other none. The largest leak ever
  //     seen on this counter in a real run is the ~30 behind BS#2194's 36
  //     (against a true value of ~6). Under a deliberate hammer-loop writer on
  //     `concerts` — ~2,350 ambient scans PER BRACKET, two orders of magnitude
  //     past anything the `--runInBand` suite produces — the two brackets still
  //     cancelled to a growth of 0. So the tolerance sits above the whole
  //     observed distribution rather than inside it, which is precisely what
  //     every absolute ceiling tried here has failed to do.
  // Neither half of that is a magnitude claim about one read, which is the
  // point: nothing below depends on how many scans a single lookup costs.
  //
  // MEASURED on the docker ci profile while writing this (BS#2194), with the
  // flush barrier in place. Batched: fewScans=16, manyScans=16, growth=0 — the
  // two page-independent queries, eight times each — across ten runs (one -1).
  // Against a deliberately reverted per-row lookup (one `concerts` query per
  // feed row, restored immediately after): fewScans=64 (8 rows x 8 reads),
  // manyScans=320 (40 rows x 8 reads), growth=256, identical on three runs.
  // The bound therefore sits exactly halfway between two readings that are each
  // reproducible to the scan — the separation the old absolute ceiling never
  // had, because it was comparing against noise instead of against the other
  // arm of the same experiment.
  //
  // Anyone re-tuning these numbers should redo that revert rather than reason
  // about it. The FIRST version of this assertion looked sound, passed on the
  // batched implementation — and then passed AGAIN under a real per-row one,
  // reading growth = -49, because the brackets were not measuring what they
  // appeared to. Only the revert caught that.
  const PER_ROW_GROWTH = COLD_READS * EXTRA_MATCHES;
  const GROWTH_CEILING = PER_ROW_GROWTH / 2;

  // Warm-cache bracket (BS#1616): reads with NO cache reset must cost ~nothing,
  // where a cache that rebuilt per read would cost one build each. Amplified
  // and derived for the same reason as above — a hard-coded constant here would
  // be the same indefensible absolute bound BS#2194 removed from the cold side,
  // read off the same database-wide counter. WARM_READS is large because a warm
  // read is just an HTTP GET (~20ms, no cache reset, no rebuild), so the
  // separation is nearly free, and it is set well above what the 3x detection
  // margin alone needs: WARM_READS and the ceiling move together, so raising it
  // buys absolute noise tolerance without weakening detection. Measured with the
  // barrier in place, warmScans is 0 on a clean run and 2,028 under the hammer
  // loop — against a ceiling that the loop's own inflated per-read cost had by
  // then widened to 8,835, which is the `Math.max` below doing its job.
  const WARM_READS = 90;
  const WARM_REBUILD_FRACTION = 1 / 3;

  it('the concerts cost of a feed read does not grow with the match count (batched, no per-row query); warm reads are served from cache', async () => {
    const pageStart = Math.min(...insertedTrackIds);
    const fewEnd = Math.max(...insertedTrackIds);

    // The MANY page is the FEW page plus EXTRA_MATCHES rows that all resolve to
    // ARTIST_WITH_SHOW. Seeded here rather than in beforeAll so every other case
    // in this file keeps reading the small fixture page.
    const extraIds = [];
    for (let i = 0; i < EXTRA_MATCHES; i++) {
      // eslint-disable-next-line no-await-in-loop
      const id = await seedTrack({ albumId: ALBUM_WITH_SHOW, artistName: 'Built to Spill', playOrder: 100 + i });
      extraIds.push(id);
    }
    insertedTrackIds.push(...extraIds);
    const manyEnd = Math.max(...extraIds);

    /**
     * COLD_READS genuinely cold reads of one page. The server memoizes the maps
     * per ET day (BS#1616), so without the reset before each read only the first
     * would scan `concerts` and every bracket would measure one build — which
     * would make the comparison below vacuous rather than merely weak.
     */
    const coldReadsOf = async (endId) => {
      for (let i = 0; i < COLD_READS; i++) {
        await resetUpcomingShowsCache(); // eslint-disable-line no-await-in-loop
        await fetchPage(pageStart, endId); // eslint-disable-line no-await-in-loop
      }
    };

    // Bracket 1 — FEW matching rows. Every boundary is "barrier, then drained
    // read", so each bracket is bounded by a published counter rather than by a
    // hopeful one. FEW runs FIRST deliberately: the ambient contributor this
    // file can generate itself is vacuum/analyze armed by the beforeAll writes,
    // which is front-loaded, and a stray burst landing in the SMALL bracket
    // inflates `fewScans` — shrinking the growth, i.e. biasing toward a false
    // PASS rather than toward the false FAIL this ticket exists to stop.
    await flushBarrier();
    const base = await quiescedScans();
    await coldReadsOf(fewEnd);
    await flushBarrier();
    const afterFew = await drainedScansAbove(base);
    const fewScans = afterFew - base;

    // Bracket 2 — the same page plus EXTRA_MATCHES more matching rows. Its
    // baseline is bracket 1's drained value, which is quiesced by construction.
    await coldReadsOf(manyEnd);
    await flushBarrier();
    const afterMany = await drainedScansAbove(afterFew);
    const manyScans = afterMany - afterFew;

    // Printed unconditionally. Each of the three BS#2194 incidents cost a
    // diagnostic cycle because the failing run reported a violated bound and not
    // the bracket values behind it, leaving "flake or my regression?" answerable
    // only by reading the commit that last moved the bound.
    const growth = manyScans - fewScans;
    console.log(
      `[upcoming_show batching] fewScans=${fewScans} manyScans=${manyScans} growth=${growth} ` +
        `ceiling=${GROWTH_CEILING} (a per-row impl would grow by >= ${PER_ROW_GROWTH})`
    );

    // Liveness lower bound: a cold read must scan `concerts` at LEAST once, else
    // the enrichment is a no-op and the comparison is vacuous — a regression
    // that stopped querying `concerts` entirely shows zero growth and would
    // otherwise sail straight through.
    expect(fewScans).toBeGreaterThanOrEqual(1);
    expect(manyScans).toBeGreaterThanOrEqual(1);

    // The load-bearing anti-N+1 assertion: cost does not scale with match count.
    expect(growth).toBeLessThan(GROWTH_CEILING);

    // Cache proof (BS#1616): the cold bracket above left the per-day map cache
    // warm. Further reads of the same page/today — with NO reset between — are
    // served entirely from it and issue ZERO `concerts` queries (confirmed by
    // statement logging during development; the deterministic per-call proof,
    // one build cold and zero warm, is in the mocked concerts.service.test.ts).
    // This is the hot-path win — getLatest stops scanning `concerts` on every
    // poll — proven end to end.
    for (let i = 0; i < WARM_READS; i++) {
      await fetchPage(pageStart, manyEnd); // eslint-disable-line no-await-in-loop
    }
    await flushBarrier();
    const afterWarm = await quiescedScans();
    const warmScans = afterWarm - afterMany;

    // Per-cold-read build cost, measured in this same run instead of asserted as
    // a constant. Floored at one scan per read (the liveness minimum) so a freak
    // small bracket can't collapse the bound to nothing, and taken as the MAX of
    // the two brackets so a noisy measurement widens the bound rather than
    // tightening it — noise must not be able to turn this into a red build.
    const perColdRead = Math.max(fewScans, manyScans, COLD_READS) / COLD_READS;
    const warmCeiling = WARM_READS * perColdRead * WARM_REBUILD_FRACTION;
    console.log(
      `[upcoming_show warm cache] warmScans=${warmScans} ceiling=${warmCeiling.toFixed(1)} ` +
        `(a per-read rebuild would cost ~${(WARM_READS * perColdRead).toFixed(0)})`
    );
    expect(warmScans).toBeLessThan(warmCeiling);
    // Four stats drains at 1.2s-16s each, two of them waiting on an advance, put
    // this case's worst case well past jest.config.json's 30s default.
  }, 120_000);

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
