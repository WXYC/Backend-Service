/**
 * BS#3635 — the co-bill pass of the V2 flowsheet `upcoming_show` embed.
 *
 * `getUpcomingShowsMaps` (apps/backend/services/concerts.service.ts) keys a
 * headliner billed with ` + ` or ` / ` (e.g. concert 67401, "The Onlies +
 * Tatiana Hargreaves") on each act as well as on the whole string, so a
 * free-text play of either act carries that concert. This spec is the
 * end-to-end, Postgres-backed proof, sibling to
 * tests/integration/flowsheet-upcoming-show-support.spec.js.
 *
 * Pins:
 *   - a free-text play of each act of a ` + ` co-bill attaches the concert;
 *   - a free-text play of an act of a ` / ` co-bill attaches the concert;
 *   - a real headline of the same act wins over a co-bill, regardless of date;
 *   - a co-bill part wins over a support row, regardless of date;
 *   - `AC/DC`-style and `&` billings stay whole (no split on a bare `/` or `&`).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs3635:';
const VENUE_SLUG = 'bs3635-probe-room';
const SHOW_NAME = 'BS#3635 co-bill-embed probe';

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

const PLUS_DATE = isoDate(7);
const SLASH_DATE = isoDate(9);
const PRECEDENCE_COBILL_SOON = isoDate(4);
const PRECEDENCE_HEADLINE_LATER = isoDate(40);
const SUPPORT_SOON = isoDate(3);
const SUPPORT_COBILL_LATER = isoDate(20);
const WHOLE_DATE = isoDate(12);

// Probe names are distinctive so a stray cross-match against real data is impossible.
const ONLIES = 'BS3635 Onlies Probe';
const HARGREAVES = 'BS3635 Hargreaves Probe';
const SLASH_ACT = 'BS3635 Dead On A Sunday Probe';
const PRECEDENCE_ACT = 'BS3635 Precedence Probe';
const SUPPORT_ACT = 'BS3635 Support Probe';
const WHOLE_SLASH = 'BS3635/AC Probe';
const WHOLE_AMP = 'BS3635 AJ Lee & Blue Summit Probe';

describe('V2 flowsheet upcoming_show enrichment — co-bill pass (BS#3635)', () => {
  let sql;
  let venueId;
  let showId;
  let insertedTrackIds = [];

  const seedConcert = async ({ key, startsOn, raw }) => {
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, headlining_artist_raw, supporting_artists_raw,
          status, raw_data, scraped_at)
       VALUES ('triangle_shows', $1, $2, $3, $4, '{}', 'on_sale', '{}'::jsonb, now())
       RETURNING id`,
      [SOURCE_ID_PREFIX + key, venueId, startsOn, raw]
    );
    return inserted.id;
  };

  const seedTrack = async (artistName, playOrder) => {
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (show_id, album_id, entry_type, artist_name, album_title, track_title, play_order, add_time, metadata_status)
       VALUES ($1, NULL, 'track', $2, 'Probe Album', 'Probe Track', $3, now(), 'enriched_match')
       RETURNING id`,
      [showId, artistName, playOrder]
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
       VALUES ($1, 'BS3635 Probe Room', 'Carrboro', 'NC', '300 E Main St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    const [show] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".shows (show_name, start_time) VALUES ($1, now()) RETURNING id`,
      [SHOW_NAME]
    );
    showId = show.id;

    await seedConcert({ key: 'plus', startsOn: PLUS_DATE, raw: `The ${ONLIES} + ${HARGREAVES}` });
    await seedConcert({ key: 'slash', startsOn: SLASH_DATE, raw: `BS3635 Wednesday 13 / ${SLASH_ACT} / Above Snakes` });

    // A real headline (LATER) beats a co-bill (SOONER).
    await seedConcert({
      key: 'precedence-cobill',
      startsOn: PRECEDENCE_COBILL_SOON,
      raw: `${PRECEDENCE_ACT} + Someone`,
    });
    await seedConcert({ key: 'precedence-headline', startsOn: PRECEDENCE_HEADLINE_LATER, raw: PRECEDENCE_ACT });

    // A co-bill part (LATER) beats a support row (SOONER).
    await seedConcert({ key: 'support-cobill', startsOn: SUPPORT_COBILL_LATER, raw: `${SUPPORT_ACT} / Someone Else` });
    const supportConcertId = await seedConcert({
      key: 'support-row',
      startsOn: SUPPORT_SOON,
      raw: 'BS3635 Unrelated Headliner',
    });
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concert_performers (concert_id, raw_name, role) VALUES ($1, $2, 'support')`,
      [supportConcertId, SUPPORT_ACT]
    );

    // No-split billings.
    await seedConcert({ key: 'whole-slash', startsOn: WHOLE_DATE, raw: WHOLE_SLASH });
    await seedConcert({ key: 'whole-amp', startsOn: WHOLE_DATE, raw: WHOLE_AMP });

    insertedTrackIds = [
      await seedTrack(`The ${ONLIES}`, 1),
      await seedTrack(HARGREAVES, 2),
      await seedTrack(SLASH_ACT, 3),
      await seedTrack(PRECEDENCE_ACT, 4),
      await seedTrack(SUPPORT_ACT, 5),
      await seedTrack('BS3635', 6), // first half of WHOLE_SLASH — must not match
      await seedTrack('BS3635 AJ Lee', 7), // first half of WHOLE_AMP — must not match
    ];

    // Force a cold read so the server rebuilds the maps against these fixtures (BS#1616).
    const res = await request.post('/internal/test/reset-upcoming-shows-cache');
    expect(res.status).toBe(204);
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  const fetchTrack = async (artistName) => {
    const startId = Math.min(...insertedTrackIds);
    const endId = Math.max(...insertedTrackIds);
    const res = await request.get('/flowsheet').query({ start_id: startId, end_id: endId });
    expect(res.status).toBe(200);
    const t = res.body.find((e) => insertedTrackIds.includes(e.id) && e.artist_name === artistName);
    expect(t).toBeDefined();
    return t;
  };

  it.each([[`The ${ONLIES}`], [HARGREAVES]])('attaches the " + " co-bill to a free-text play of %s', async (name) => {
    const t = await fetchTrack(name);
    expect(t.upcoming_show).toMatchObject({
      starts_on: PLUS_DATE,
      headlining_artist_raw: `The ${ONLIES} + ${HARGREAVES}`,
      venue: { slug: VENUE_SLUG },
    });
  });

  it('attaches the " / " co-bill to a free-text play of a middle act', async () => {
    const t = await fetchTrack(SLASH_ACT);
    expect(t.upcoming_show).toMatchObject({ starts_on: SLASH_DATE });
  });

  it('a real headline wins over a co-bill, regardless of date', async () => {
    const t = await fetchTrack(PRECEDENCE_ACT);
    expect(t.upcoming_show.starts_on).toBe(PRECEDENCE_HEADLINE_LATER);
    expect(t.upcoming_show.headlining_artist_raw).toBe(PRECEDENCE_ACT);
  });

  it('a co-bill part wins over a support row, regardless of date', async () => {
    const t = await fetchTrack(SUPPORT_ACT);
    expect(t.upcoming_show.starts_on).toBe(SUPPORT_COBILL_LATER);
  });

  it.each([['BS3635'], ['BS3635 AJ Lee']])('does not split a bare "/" or "&" billing (play of %s)', async (name) => {
    const t = await fetchTrack(name);
    expect(t).not.toHaveProperty('upcoming_show');
  });
});
