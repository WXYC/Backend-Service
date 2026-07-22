/**
 * Integration tests for the concert poster-art enrichment pipeline (BS#1743)
 * against a REAL Postgres.
 *
 * Two halves, both DB-backed:
 *
 *  1. Candidate selection (`jobs/concerts-poster-enrichment/query.ts`): the
 *     COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)
 *     effective-id, the `image_url IS NULL` filter, the upcoming-only window,
 *     the `--backfill` window that drops it, and that a shared headliner
 *     across multiple concerts surfaces one row PER CONCERT (dedup happens
 *     in-memory in the orchestrator, not in SQL).
 *  2. The writer (`jobs/concerts-poster-enrichment/writer.ts`): the fill
 *     path (a NULL `image_url` gets written) and the skip-on-non-null path
 *     (an already-populated `image_url` is never overwritten, even when a
 *     write is attempted against it) plus re-run idempotency.
 *
 * Pure SQL — does NOT import the TS job (the integration runner is
 * babel-jest with no TS support); the SQL here mirrors query.ts / writer.ts
 * and must follow when they change. Mirrors the sibling
 * `concerts-genre-enrichment.spec.js` in shape.
 *
 * WXYC-representative headliners (Juana Molina, Stereolab, Chuquimamani-Condori)
 * per the org fixture convention. Needs CI to run: requires the Docker
 * integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1743:';
const VENUE_SLUG = 'bs1743-probe-room';

// Stable, high Discogs ids so they never collide with seeded fixture data.
const DISCOGS_LIBRARY_UNENRICHED = 91743001; // Lane A (library FK), image_url NULL.
const DISCOGS_EXTERNAL = 91743002; // Lane B (headlining_discogs_artist_id only), image_url NULL, TWO shows.
const DISCOGS_HAS_IMAGE = 91743003; // resolved, but image_url already populated — never a candidate.
const DISCOGS_PAST = 91743004; // Lane B, image_url NULL, PAST show (nightly excludes; backfill includes).
// Ids used only by the writer half, so they can't perturb the candidate-selection assertions.
const DISCOGS_WRITE_FILL = 91743901;
const DISCOGS_WRITE_SKIP = 91743902;
const DISCOGS_WRITE_RERUN = 91743903;

const ARTIST_LIBRARY_UNENRICHED = 'Stereolab';
const EXISTING_IMAGE_URL = 'https://discogs.example/existing-poster.jpg';

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

/** YYYY-MM-DD for today + offsetDays, in America/New_York (matches the job + read window). */
function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

const IN_10 = isoDate(10);
const IN_15 = isoDate(15);
const PAST = isoDate(-30);

/**
 * Candidate query — a faithful mirror of
 * `jobs/concerts-poster-enrichment/query.ts#loadEnrichmentCandidates`, scoped
 * by the test source_id prefix so a shared schema's other rows can't perturb
 * the assertion (the real query is unscoped).
 */
async function loadCandidates(sql, { backfill = false } = {}) {
  const windowClause = backfill ? sql`` : sql`AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;
  return sql`
    SELECT
      c."id" AS concert_id,
      COALESCE(c."headlining_discogs_artist_id", a."discogs_artist_id") AS discogs_artist_id
    FROM ${sql(SCHEMA)}."concerts" c
    LEFT JOIN ${sql(SCHEMA)}."artists" a ON a."id" = c."headlining_artist_id"
    WHERE c."removed_at" IS NULL
      AND c."image_url" IS NULL
      ${windowClause}
      AND COALESCE(c."headlining_discogs_artist_id", a."discogs_artist_id") IS NOT NULL
      AND c."source_id" LIKE ${SOURCE_ID_PREFIX + '%'}
    ORDER BY c."id" ASC
  `;
}

/**
 * Writer mirror of `jobs/concerts-poster-enrichment/writer.ts#writeConcertImages`
 * for ONE artist row: UPDATE the given concert ids' `image_url`, guarded to
 * rows currently NULL. Returns the updated rows.
 */
async function writeConcertImage(sql, { concertIds, imageUrl }) {
  return sql`
    UPDATE ${sql(SCHEMA)}."concerts"
    SET "image_url" = ${imageUrl}
    WHERE "id" = ANY(${concertIds})
      AND "image_url" IS NULL
    RETURNING "id"
  `;
}

describe('concerts poster enrichment (BS#1743)', () => {
  let sql;
  let venueId;
  let libraryUnenrichedArtistId;

  const seedConcert = async (o) => {
    const [row] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, headlining_artist_raw,
          headlining_artist_id, headlining_discogs_artist_id, image_url, removed_at, raw_data, scraped_at)
       VALUES ('triangle_shows', $1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, now())
       RETURNING id`,
      [
        SOURCE_ID_PREFIX + o.key,
        o.venue_id,
        o.starts_on,
        o.headlining_artist_raw,
        o.headlining_artist_id ?? null,
        o.headlining_discogs_artist_id ?? null,
        o.image_url ?? null,
        o.removed_at ?? null,
      ]
    );
    return row.id;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    // Delete by the test's synthetic discogs_artist_id, NOT by name: the CI seed
    // clone already contains real artists with these WXYC names whose `library`
    // rows FK-reference `artists.id`, so a name-based delete hits those seed
    // rows. The synthetic ids (917430xx / 917439xx) exist only in this test.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE discogs_artist_id = ANY($1)`, [
      [DISCOGS_LIBRARY_UNENRICHED],
    ]);
  };

  beforeAll(async () => {
    sql = makeSql();
    await cleanup();

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1743 Probe Room', 'Carrboro', 'NC', '300 E Main St') RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    // Library artist, resolved, image_url NULL.
    const [a1] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [ARTIST_LIBRARY_UNENRICHED, DISCOGS_LIBRARY_UNENRICHED]
    );
    libraryUnenrichedArtistId = a1.id;

    // Lane A, resolved, image_url NULL, upcoming.
    await seedConcert({
      key: 'library-unenriched',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: ARTIST_LIBRARY_UNENRICHED,
      headlining_artist_id: libraryUnenrichedArtistId,
    });
    // Lane B (external Discogs id only), image_url NULL, upcoming — TWO shows
    // for the SAME artist to prove the query surfaces one row PER CONCERT
    // (dedup is the orchestrator's job, not the SQL's).
    await seedConcert({
      key: 'external-a',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: 'Chuquimamani-Condori',
      headlining_discogs_artist_id: DISCOGS_EXTERNAL,
    });
    await seedConcert({
      key: 'external-b',
      venue_id: venueId,
      starts_on: IN_15,
      headlining_artist_raw: 'Chuquimamani-Condori',
      headlining_discogs_artist_id: DISCOGS_EXTERNAL,
    });
    // Resolved headliner, but image_url ALREADY populated — never a candidate.
    await seedConcert({
      key: 'has-image',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: 'Csillagrablók',
      headlining_discogs_artist_id: DISCOGS_HAS_IMAGE,
      image_url: EXISTING_IMAGE_URL,
    });
    // Unresolved headliner — no id either lane; never a candidate.
    await seedConcert({
      key: 'unresolved',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: 'Some Unresolved Billing & Another',
    });
    // Lane B, image_url NULL, PAST — nightly excludes (upcoming-only), backfill includes.
    await seedConcert({
      key: 'external-past',
      venue_id: venueId,
      starts_on: PAST,
      headlining_artist_raw: 'Long Gone Touring Act',
      headlining_discogs_artist_id: DISCOGS_PAST,
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  describe('candidate selection (mirror of query.ts)', () => {
    it('selects resolved concerts missing a poster (both lanes), excluding has-image/unresolved', async () => {
      const rows = await loadCandidates(sql);
      const ids = rows.map((r) => Number(r.discogs_artist_id));

      expect(ids).toContain(DISCOGS_LIBRARY_UNENRICHED);
      expect(ids).toContain(DISCOGS_EXTERNAL);
      // Excluded: already has a poster, unresolved (no id), and the past show
      // (outside the nightly upcoming window).
      expect(ids).not.toContain(DISCOGS_HAS_IMAGE);
      expect(ids).not.toContain(DISCOGS_PAST);
    });

    it("surfaces one candidate row PER CONCERT, not deduped by artist (dedup is the orchestrator's job)", async () => {
      const rows = await loadCandidates(sql);
      const externalRows = rows.filter((r) => Number(r.discogs_artist_id) === DISCOGS_EXTERNAL);
      expect(externalRows).toHaveLength(2);
    });

    it('carries the concert_id alongside the effective discogs_artist_id', async () => {
      const rows = await loadCandidates(sql);
      const libraryRow = rows.find((r) => Number(r.discogs_artist_id) === DISCOGS_LIBRARY_UNENRICHED);
      expect(libraryRow).toBeDefined();
      expect(typeof libraryRow.concert_id).toBe('number');
    });

    it('--backfill drops the upcoming-only window and includes the past resolved headliner', async () => {
      const nightly = (await loadCandidates(sql)).map((r) => Number(r.discogs_artist_id));
      const backfill = (await loadCandidates(sql, { backfill: true })).map((r) => Number(r.discogs_artist_id));
      expect(nightly).not.toContain(DISCOGS_PAST);
      expect(backfill).toContain(DISCOGS_PAST);
    });
  });

  describe('writer (mirror of writer.ts): fill path, skip-on-non-null, idempotency', () => {
    it('fills a NULL image_url', async () => {
      const concertId = await seedConcert({
        key: 'write-fill',
        venue_id: venueId,
        starts_on: IN_10,
        headlining_artist_raw: 'Jessica Pratt',
        headlining_discogs_artist_id: DISCOGS_WRITE_FILL,
      });

      const updated = await writeConcertImage(sql, {
        concertIds: [concertId],
        imageUrl: 'https://discogs.example/jessica-pratt.jpg',
      });
      expect(updated).toHaveLength(1);

      const [row] = await sql.unsafe(`SELECT image_url FROM "${SCHEMA}".concerts WHERE id = $1`, [concertId]);
      expect(row.image_url).toBe('https://discogs.example/jessica-pratt.jpg');
    });

    it('never overwrites an already-populated image_url', async () => {
      const concertId = await seedConcert({
        key: 'write-skip',
        venue_id: venueId,
        starts_on: IN_10,
        headlining_artist_raw: 'Csillagrablók',
        headlining_discogs_artist_id: DISCOGS_WRITE_SKIP,
        image_url: EXISTING_IMAGE_URL,
      });

      const updated = await writeConcertImage(sql, {
        concertIds: [concertId],
        imageUrl: 'https://discogs.example/a-different-poster.jpg',
      });
      expect(updated).toHaveLength(0);

      const [row] = await sql.unsafe(`SELECT image_url FROM "${SCHEMA}".concerts WHERE id = $1`, [concertId]);
      expect(row.image_url).toBe(EXISTING_IMAGE_URL);
    });

    it('a re-run over an already-filled row updates 0 and leaves the first-written value intact', async () => {
      const concertId = await seedConcert({
        key: 'write-rerun',
        venue_id: venueId,
        starts_on: IN_10,
        headlining_artist_raw: 'Hermanos Gutiérrez',
        headlining_discogs_artist_id: DISCOGS_WRITE_RERUN,
      });

      const first = await writeConcertImage(sql, {
        concertIds: [concertId],
        imageUrl: 'https://discogs.example/hermanos-gutierrez-v1.jpg',
      });
      expect(first).toHaveLength(1);

      const second = await writeConcertImage(sql, {
        concertIds: [concertId],
        imageUrl: 'https://discogs.example/hermanos-gutierrez-v2.jpg',
      });
      expect(second).toHaveLength(0);

      const [row] = await sql.unsafe(`SELECT image_url FROM "${SCHEMA}".concerts WHERE id = $1`, [concertId]);
      expect(row.image_url).toBe('https://discogs.example/hermanos-gutierrez-v1.jpg');
    });

    it('fans a single artist write out to multiple concert ids in one call', async () => {
      const idA = await seedConcert({
        key: 'write-fanout-a',
        venue_id: venueId,
        starts_on: IN_10,
        headlining_artist_raw: 'Chuquimamani-Condori',
        headlining_discogs_artist_id: DISCOGS_EXTERNAL,
      });
      const idB = await seedConcert({
        key: 'write-fanout-b',
        venue_id: venueId,
        starts_on: IN_15,
        headlining_artist_raw: 'Chuquimamani-Condori',
        headlining_discogs_artist_id: DISCOGS_EXTERNAL,
      });

      const updated = await writeConcertImage(sql, {
        concertIds: [idA, idB],
        imageUrl: 'https://discogs.example/chuquimamani-condori.jpg',
      });
      expect(updated.map((r) => r.id).sort()).toEqual([idA, idB].sort());
    });
  });
});
