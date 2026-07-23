/**
 * BS#1761 — PASS 2 of the V2 flowsheet `upcoming_show` embed: support acts.
 *
 * `getUpcomingShowsMaps` (apps/backend/services/concerts.service.ts) widens
 * from a single headliner-only pass (BS#1607, BS#1613) to two passes: the
 * existing headliner pass, then a new pass over active (non-tombstoned)
 * `concert_performers` rows with `role = 'support'`. This spec is the
 * end-to-end, Postgres-backed proof — sibling to
 * tests/integration/flowsheet-upcoming-show.spec.js, which pins Pass 1 and is
 * left untouched by this change.
 *
 * Pins:
 *   - a play of a library artist who only SUPPORTS an upcoming show (never
 *     headlines) carries `upcoming_show` via the id arm
 *     (`concert_performers.artist_id`);
 *   - a free-text play matches an UNRESOLVED support act by its raw junction
 *     name (the name arm) — no library id required;
 *   - a headliner CTA beats a support CTA for the SAME artist regardless of
 *     date: a LATER headliner concert wins over an EARLIER support concert;
 *   - soonest wins WITHIN the support arm across several support dates;
 *   - a TOMBSTONED (`removed_at` set) support row is excluded from both arms;
 *   - EXPLAIN proves the support query can drive off
 *     `concerts_active_starts_on_id_idx` and reach `concert_performers` via
 *     the leading `concert_id` column of its
 *     `concert_performers_concert_role_raw_name_idx` — no seq scan required
 *     at production scale (BS#1761 ticket constraint).
 *
 * Artist/library fixtures: this spec creates its OWN `artists` + `library`
 * rows (cleaned up in `afterAll`) rather than assuming specific ids from
 * `dev_env/seed_db.sql`. Local dev database volumes persist across sessions
 * (`npm run db:stop` drops it; nothing else does) and accumulate drift from
 * whatever has run against them, so a fixed-id assumption like "library id 4
 * is Sufjan Stevens" — true on a freshly-provisioned DB — is not safe to rely
 * on here. Creating fresh rows sidesteps that drift entirely and matches the
 * precedent in concerts-genre-enrichment.spec.js / concerts-by-id.spec.js /
 * flowsheet-artwork-repair.spec.js, among others.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1761:';
const VENUE_SLUG = 'bs1761-probe-room';
const SHOW_NAME = 'BS#1761 support-embed probe';
const ARTIST_NAME_PREFIX = 'BS1761 Probe Artist ';

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

// Precedence dates: the SUPPORT date is sooner, the HEADLINER date is later —
// the headliner must still win.
const PRECEDENCE_SUPPORT_SOON = isoDate(3);
const PRECEDENCE_HEADLINER_LATER = isoDate(30);

// Soonest-within-support dates for the same normalized name.
const SUPPORT_SOON = isoDate(5);
const SUPPORT_LATER = isoDate(28);

const SUPPORT_ONLY_DATE = isoDate(9);
const NAME_ARM_DATE = isoDate(11);
const TOMBSTONED_DATE = isoDate(13);

describe('V2 flowsheet upcoming_show enrichment — support arm (BS#1761)', () => {
  let sql;
  let venueId;
  let showId;
  let insertedTrackIds = [];
  let genreId;
  let formatId;
  // Resolved id-arm fixtures, created fresh in beforeAll (see file header).
  let artistSupportOnly; // { artistId, libraryId } — support-only base case
  let artistPrecedence; // { artistId, libraryId } — headliner-beats-support case

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
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, starts_at, doors_at,
          headlining_artist_raw, headlining_artist_id, title, supporting_artists_raw,
          ticket_url, image_url, price_min, price_max, age_restriction, status,
          removed_at, raw_data, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '{}'::jsonb, now())
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
      ]
    );
    return inserted.id;
  };

  /** Insert one active (or, if removedAt given, tombstoned) `support` performer row. */
  const seedSupportPerformer = async (concertId, rawName, { artistId = null, removedAt = null } = {}) => {
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concert_performers
         (concert_id, raw_name, role, artist_id, removed_at)
       VALUES ($1, $2, 'support', $3, $4)`,
      [concertId, rawName, artistId, removedAt]
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

  /**
   * Create a fresh `artists` row plus one linked `library` row, so this spec
   * has a real, unambiguous `(artist_id, library_id)` pair for the id-arm
   * tests without assuming anything about pre-existing seed data (see file
   * header). Name is distinct from every OTHER free-text fixture name used in
   * this file so a stray cross-match would be obvious.
   *
   * Explicit id (`COALESCE(MAX(id), 0) + 1`, computed in the same statement as
   * the INSERT) rather than the column's SERIAL default: this dev DB's clone
   * fixture (`dev_env/seed-clone.sql`, see docs/dev-db-fixture.md) loads
   * `artists`/`library` rows with explicit ids without advancing
   * `artists_id_seq`/`library_id_seq` to match, so a plain `nextval()`-backed
   * insert collides with an existing row (`artists_pkey`/`library_pkey`
   * violation) on this environment. Computing the id directly sidesteps the
   * desynced sequence entirely rather than depending on it being resynced.
   */
  const createResolvedArtist = async (name) => {
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (id, artist_name, alphabetical_name, code_letters)
       SELECT COALESCE(MAX(id), 0) + 1, $1, $1, 'ZZ' FROM "${SCHEMA}".artists
       RETURNING id`,
      [ARTIST_NAME_PREFIX + name]
    );
    const [library] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (id, artist_id, genre_id, format_id, album_title, code_number)
       SELECT COALESCE(MAX(id), 0) + 1, $1, $2, $3, $4, 0 FROM "${SCHEMA}".library
       RETURNING id`,
      [artist.id, genreId, formatId, `BS1761 Probe Album ${name}`]
    );
    return { artistId: artist.id, libraryId: library.id };
  };

  const cleanup = async () => {
    // ON DELETE CASCADE on concert_performers.concert_id removes this spec's
    // performer rows automatically when their parent concert is deleted.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    if (insertedTrackIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedTrackIds]);
    }
    if (showId) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE id = $1`, [showId]);
    }
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    // library rows first (FK -> artists), then the artists themselves. Scoped
    // by the distinctive name prefix as a belt-and-suspenders match alongside
    // the id lists, in case a prior run's ids were lost (e.g. a crash before
    // this cleanup ran).
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE 'BS1761 Probe Album%'`);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name LIKE $1`, [`${ARTIST_NAME_PREFIX}%`]);
  };

  /** Mirrors flowsheet-upcoming-show.spec.js's cache-reset helper (BS#1616). */
  const resetUpcomingShowsCache = async () => {
    const res = await request.post('/internal/test/reset-upcoming-shows-cache');
    expect(res.status).toBe(204);
  };

  beforeAll(async () => {
    sql = makeSql();
    await cleanup();

    const [genre] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".genres ORDER BY id LIMIT 1`);
    genreId = genre.id;
    const [format] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);
    formatId = format.id;

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1761 Probe Room', 'Carrboro', 'NC', '300 E Main St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    const [show] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".shows (show_name, start_time) VALUES ($1, now()) RETURNING id`,
      [SHOW_NAME]
    );
    showId = show.id;

    artistSupportOnly = await createResolvedArtist('Support Only');
    artistPrecedence = await createResolvedArtist('Precedence');

    // --- Case 1: resolved support, id arm, no competing headliner ---
    const supportOnlyConcertId = await seedConcert({
      key: 'support-only',
      venue_id: venueId,
      starts_on: SUPPORT_ONLY_DATE,
      headlining_artist_raw: 'Some Unrelated Headliner',
    });
    await seedSupportPerformer(supportOnlyConcertId, ARTIST_NAME_PREFIX + 'Support Only', {
      artistId: artistSupportOnly.artistId,
    });

    // --- Case 2: unresolved support, name arm ---
    const nameArmConcertId = await seedConcert({
      key: 'name-arm',
      venue_id: venueId,
      starts_on: NAME_ARM_DATE,
      headlining_artist_raw: 'A Different Headliner',
    });
    await seedSupportPerformer(nameArmConcertId, 'Carmen Villain');

    // --- Case 3: headliner beats support regardless of date (id arm) ---
    const precedenceHeadlinerConcertId = await seedConcert({
      key: 'precedence-headliner',
      venue_id: venueId,
      starts_on: PRECEDENCE_HEADLINER_LATER, // LATER
      headlining_artist_raw: ARTIST_NAME_PREFIX + 'Precedence',
      headlining_artist_id: artistPrecedence.artistId,
    });
    const precedenceSupportConcertId = await seedConcert({
      key: 'precedence-support',
      venue_id: venueId,
      starts_on: PRECEDENCE_SUPPORT_SOON, // EARLIER — must still lose
      headlining_artist_raw: 'Some Other Headliner',
    });
    await seedSupportPerformer(precedenceSupportConcertId, ARTIST_NAME_PREFIX + 'Precedence', {
      artistId: artistPrecedence.artistId,
    });

    // --- Case 4: soonest wins within the support arm (name arm) ---
    const supportLaterConcertId = await seedConcert({
      key: 'support-soonest-later',
      venue_id: venueId,
      starts_on: SUPPORT_LATER,
      headlining_artist_raw: 'Headliner For Later Support Show',
    });
    await seedSupportPerformer(supportLaterConcertId, 'Angel Olsen');
    const supportSoonConcertId = await seedConcert({
      key: 'support-soonest-soon',
      venue_id: venueId,
      starts_on: SUPPORT_SOON,
      headlining_artist_raw: 'Headliner For Soon Support Show',
    });
    await seedSupportPerformer(supportSoonConcertId, 'Angel Olsen');

    // --- Case 5: a tombstoned support row is excluded from both arms ---
    const tombstonedConcertId = await seedConcert({
      key: 'tombstoned-support',
      venue_id: venueId,
      starts_on: TOMBSTONED_DATE,
      headlining_artist_raw: 'Headliner For Tombstoned Support Show',
    });
    await seedSupportPerformer(tombstonedConcertId, 'Big Thief', { removedAt: new Date().toISOString() });

    // Track rows.
    const t1 = await seedTrack({
      albumId: artistSupportOnly.libraryId,
      artistName: ARTIST_NAME_PREFIX + 'Support Only',
      playOrder: 1,
    });
    const t2 = await seedTrack({ albumId: null, artistName: 'Carmen Villain', playOrder: 2 });
    const t3 = await seedTrack({
      albumId: artistPrecedence.libraryId,
      artistName: ARTIST_NAME_PREFIX + 'Precedence',
      playOrder: 3,
    });
    const t4 = await seedTrack({ albumId: null, artistName: 'Angel Olsen', playOrder: 4 });
    const t5 = await seedTrack({ albumId: null, artistName: 'Big Thief', playOrder: 5 });
    insertedTrackIds = [t1, t2, t3, t4, t5];

    // Force a genuine cold read so the server rebuilds the maps against these
    // freshly seeded fixtures (BS#1616 per-process cache).
    await resetUpcomingShowsCache();
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

  it('attaches a support-only concert to a linked track via the id arm', async () => {
    const tracks = await fetchSeededTracks();
    const t = tracks.find((e) => e.album_id === artistSupportOnly.libraryId);
    expect(t).toBeDefined();
    expect(t.upcoming_show).toBeDefined();
    expect(t.upcoming_show).toMatchObject({
      starts_on: SUPPORT_ONLY_DATE,
      headlining_artist_raw: 'Some Unrelated Headliner',
      headlining_artist_id: null,
      venue: { slug: VENUE_SLUG },
    });
    // Leak barrier: the support-matched show carries no internal ingestion columns.
    for (const internal of ['source', 'source_id', 'raw_data', 'scraped_at', 'first_scraped_at', 'removed_at']) {
      expect(t.upcoming_show).not.toHaveProperty(internal);
    }
  });

  it('attaches an unresolved support to a free-text play via the name arm', async () => {
    const tracks = await fetchSeededTracks();
    const t = tracks.find((e) => e.album_id === null && e.artist_name === 'Carmen Villain');
    expect(t).toBeDefined();
    expect(t.upcoming_show).toBeDefined();
    expect(t.upcoming_show).toMatchObject({
      starts_on: NAME_ARM_DATE,
      headlining_artist_raw: 'A Different Headliner',
      headlining_artist_id: null, // the CONCERT's headliner is unresolved — matched via the support name arm
      venue: { slug: VENUE_SLUG },
    });
  });

  it('a headliner beats a support for the same artist regardless of date (later headliner, earlier support)', async () => {
    const tracks = await fetchSeededTracks();
    const t = tracks.find((e) => e.album_id === artistPrecedence.libraryId);
    expect(t).toBeDefined();
    expect(t.upcoming_show).toBeDefined();
    // The LATER headliner concert wins, even though the support concert is sooner.
    expect(t.upcoming_show.starts_on).toBe(PRECEDENCE_HEADLINER_LATER);
    expect(t.upcoming_show.starts_on).not.toBe(PRECEDENCE_SUPPORT_SOON);
    expect(t.upcoming_show.headlining_artist_id).toBe(artistPrecedence.artistId);
  });

  it('collapses several support dates for the same name to the SOONEST', async () => {
    const tracks = await fetchSeededTracks();
    const t = tracks.find((e) => e.album_id === null && e.artist_name === 'Angel Olsen');
    expect(t).toBeDefined();
    expect(t.upcoming_show).toBeDefined();
    expect(t.upcoming_show.starts_on).toBe(SUPPORT_SOON);
    expect(t.upcoming_show.starts_on).not.toBe(SUPPORT_LATER);
  });

  it('a tombstoned (removed_at set) support row does not attach', async () => {
    const tracks = await fetchSeededTracks();
    const t = tracks.find((e) => e.album_id === null && e.artist_name === 'Big Thief');
    expect(t).toBeDefined();
    expect(t).not.toHaveProperty('upcoming_show');
  });

  /**
   * EXPLAIN proof (BS#1761 ticket constraint): the support query can drive
   * off `concerts_active_starts_on_id_idx` for the outer `concerts` scan and
   * reach `concert_performers` via the leading `concert_id` column of
   * `concert_performers_concert_role_raw_name_idx` — no new index required.
   *
   * Mirrors the `concerts-artist-lml-resolver-writer.spec.js` EXPLAIN
   * pattern: `enable_seqscan = off` inside a ROLLED-BACK transaction
   * neutralizes the tiny-test-dataset confounder (a handful of rows makes a
   * seq scan cheaper regardless of index availability), so the plan reflects
   * what the query is structurally capable of at production scale. The
   * sentinel throw guarantees the setting never leaks past this test.
   *
   * The SQL below is a hand mirror of the Drizzle query in
   * `getUpcomingShowsMaps`'s Pass 2 (apps/backend/services/concerts.service.ts)
   * — when that query's join/where shape changes, this mirror must follow.
   */
  it('EXPLAIN: the support query can drive off concerts_active_starts_on_id_idx into concert_performers', async () => {
    let planJson;
    const sentinel = new Error('rollback-explain-probe');
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL enable_seqscan = off`);
        const rows = await tx.unsafe(
          `EXPLAIN (FORMAT JSON)
           SELECT c."id", v."id", cp."raw_name", cp."artist_id"
           FROM "${SCHEMA}".concerts c
           JOIN "${SCHEMA}".concert_performers cp ON cp."concert_id" = c."id"
           JOIN "${SCHEMA}".venues v ON v."id" = c."venue_id"
           WHERE cp."role" = 'support'
             AND cp."removed_at" IS NULL
             AND c."removed_at" IS NULL
             AND c."starts_on" >= CURRENT_DATE
           ORDER BY c."starts_on" ASC, c."id" ASC, cp."id" ASC`
        );
        planJson = JSON.stringify(rows[0]['QUERY PLAN']);
        throw sentinel;
      });
    } catch (err) {
      if (err !== sentinel) throw err;
    }
    expect(planJson).toContain('concerts_active_starts_on_id_idx');
    expect(planJson).toContain('concert_performers');
  });
});
