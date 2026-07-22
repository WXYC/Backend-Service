/**
 * Integration test for the `concerts.image_url` retention guard (BS#1742).
 *
 * Both concert writers (`jobs/triangle-shows-etl/writer.ts` and
 * `jobs/venue-events-scraper/writer.ts`) UPSERT `concerts` keyed on
 * `(source, source_id)`. Every field in their `onConflictDoUpdate` set is a
 * plain source-authoritative overwrite EXCEPT `image_url`, which is guarded
 * with `COALESCE(excluded."image_url", concerts.image_url)` — incoming value
 * wins when present, falling back to the stored value only when the scrape
 * came back with a null image. Without the guard, a later image-less scrape
 * nulls out a poster a previous scrape had captured.
 *
 * Argument order matters and is the OPPOSITE of the nearest repo precedent
 * (`jobs/flowsheet-linked-reenrichment/job.ts`'s `album_metadata.artwork_url`
 * COALESCE, which is keep-existing-first because that writer treats the
 * table as the authority once populated). Here the source re-scrape should
 * win when it has a fresher image, so `excluded` goes first.
 *
 * Pure SQL — does NOT import either writer (the integration runner is
 * babel-jest with no TS support); this mirrors the writers' `onConflictDoUpdate`
 * set clause and must be kept in sync with them. Modeled on
 * `concerts-genre-enrichment.spec.js` in shape (real `postgres()` client via
 * `makeSql()`, source_id-prefix scoping for isolated cleanup).
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1742:';
const VENUE_SLUG = 'bs1742-probe-room';

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

/** YYYY-MM-DD for today + offsetDays, in America/New_York. */
function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

const STARTS_ON = isoDate(10);

/**
 * UPSERT mirror of the `onConflictDoUpdate` set clause both writers share
 * for `image_url`: source-authoritative for every other column, but
 * `image_url` is COALESCE(excluded, stored) so a null incoming value never
 * clobbers a previously-captured poster. Only the columns relevant to that
 * guard are reimplemented (venue_id/starts_on/headlining_artist_raw/
 * ticket_url as plain-overwrite contrast columns, image_url guarded).
 */
async function upsertConcert(sql, { venueId, sourceId, startsOn, headliningArtistRaw, ticketUrl, imageUrl }) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}."concerts"
      (source, source_id, venue_id, starts_on, headlining_artist_raw, ticket_url, image_url, raw_data, scraped_at)
    VALUES
      ('triangle_shows', ${sourceId}, ${venueId}, ${startsOn}, ${headliningArtistRaw}, ${ticketUrl}, ${imageUrl}, '{}'::jsonb, now())
    ON CONFLICT (source, source_id) DO UPDATE SET
      venue_id = excluded."venue_id",
      starts_on = excluded."starts_on",
      headlining_artist_raw = excluded."headlining_artist_raw",
      ticket_url = excluded."ticket_url",
      image_url = COALESCE(excluded."image_url", ${sql(SCHEMA)}."concerts"."image_url"),
      last_modified = now()
  `;
}

describe('concerts.image_url retention on re-upsert (BS#1742)', () => {
  let sql;
  let venueId;

  beforeAll(async () => {
    sql = makeSql();
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1742 Probe Room', 'Carrboro', 'NC', '300 E Main St') RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;
  });

  afterAll(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    await sql.end();
  });

  test('a captured poster survives a later re-scrape that comes back with a null image', async () => {
    const sourceId = SOURCE_ID_PREFIX + 'retained';

    await upsertConcert(sql, {
      venueId,
      sourceId,
      startsOn: STARTS_ON,
      headliningArtistRaw: 'Juana Molina',
      ticketUrl: 'https://tickets.example/juana-molina',
      imageUrl: 'https://cdn.example/posters/juana-molina.jpg',
    });

    // Re-scrape: same concert, but this pass came back with no image.
    await upsertConcert(sql, {
      venueId,
      sourceId,
      startsOn: STARTS_ON,
      headliningArtistRaw: 'Juana Molina',
      ticketUrl: 'https://tickets.example/juana-molina-v2',
      imageUrl: null,
    });

    const [row] = await sql.unsafe(`SELECT ticket_url, image_url FROM "${SCHEMA}".concerts WHERE source_id = $1`, [
      sourceId,
    ]);
    // The other field is plain-overwrite (proves the COALESCE isn't blanket).
    expect(row.ticket_url).toBe('https://tickets.example/juana-molina-v2');
    // image_url is retained despite the null incoming value.
    expect(row.image_url).toBe('https://cdn.example/posters/juana-molina.jpg');
  });

  test('a real image populates a previously image-less row (a fresher poster still wins)', async () => {
    const sourceId = SOURCE_ID_PREFIX + 'populated';

    await upsertConcert(sql, {
      venueId,
      sourceId,
      startsOn: STARTS_ON,
      headliningArtistRaw: 'Chuquimamani-Condori',
      ticketUrl: 'https://tickets.example/chuquimamani-condori',
      imageUrl: null,
    });

    // Re-scrape: this pass captured a poster for the first time.
    await upsertConcert(sql, {
      venueId,
      sourceId,
      startsOn: STARTS_ON,
      headliningArtistRaw: 'Chuquimamani-Condori',
      ticketUrl: 'https://tickets.example/chuquimamani-condori',
      imageUrl: 'https://cdn.example/posters/chuquimamani-condori.jpg',
    });

    const [row] = await sql.unsafe(`SELECT image_url FROM "${SCHEMA}".concerts WHERE source_id = $1`, [sourceId]);
    expect(row.image_url).toBe('https://cdn.example/posters/chuquimamani-condori.jpg');
  });
});
