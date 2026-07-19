/**
 * Integration tests for the concerts similar-artists enrichment pipeline
 * (BS#1626) against a REAL Postgres (migration 0122 `artist_similar_artists` +
 * the read-path LEFT JOIN in apps/backend/services/concerts.service.ts).
 *
 * Two halves, both DB-backed:
 *
 *  1. The nightly enrichment's DB contract, validating the SQL the job issues:
 *     - candidate selection (`jobs/concerts-similar-artists-enrichment/query.ts`):
 *       IN-LIBRARY only (`headlining_artist_id IS NOT NULL` — a Discogs-only
 *       headliner is NOT a candidate), DISTINCT, the upcoming-only window, and
 *       the `--backfill` window that drops it;
 *     - the OVERWRITE writer (`jobs/concerts-similar-artists-enrichment/writer.ts`):
 *       UPSERT `ON CONFLICT DO UPDATE` OVERWRITES an existing row (the opposite
 *       of the genre sibling's DO-NOTHING), and the scoped DELETE clears an
 *       emptied row.
 *  2. The read projection: `GET /concerts` (and `GET /concerts/:id`) emit
 *     `similar_artists` (BS#1626) and `station_plays` (BS#1702) for a resolved +
 *     enriched headliner and `null` when unresolved or un-enriched. The by-id
 *     assertion is the regression guard for the lockstep `artist_station_plays`
 *     LEFT JOIN (the same class of miss as the BS#1694 by-id 500).
 *
 * Pure SQL for half 1 — does NOT import the TS job (the integration runner is
 * babel-jest with no TS support); the SQL here mirrors query.ts / writer.ts and
 * must follow when they change. Mirrors the sibling
 * `concerts-genre-enrichment.spec.js` in shape.
 *
 * WXYC-representative headliners (Juana Molina, Stereolab, Jessica Pratt) per
 * the org fixture convention. Needs CI to run: requires the Docker integration
 * DB (the `pg` marker tier).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1626:';
const VENUE_SLUG = 'bs1626-probe-room';

// Stable, high Discogs ids so they never collide with seeded fixture data.
const DISCOGS_ENRICHED = 91626001;
const DISCOGS_UNENRICHED = 91626002;
const DISCOGS_PAST = 91626003;
const DISCOGS_ONLY = 91626004; // Discogs-only lane: no artists row — must be EXCLUDED.
// Writer-only artists: real artists rows with NO concerts, used solely by the
// OVERWRITE-writer half so it can't perturb the projection half's null cases.
const DISCOGS_WRITER_A = 91626901;
const DISCOGS_WRITER_B = 91626902;

const ARTIST_ENRICHED = 'Juana Molina'; // in-library, resolved + enriched
const ARTIST_UNENRICHED = 'Stereolab'; // in-library, resolved, not yet enriched
const ARTIST_PAST = 'Jessica Pratt'; // in-library, resolved, PAST show

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
const IN_20 = isoDate(20);
const PAST = isoDate(-30);

/**
 * Candidate query — a faithful mirror of
 * `jobs/concerts-similar-artists-enrichment/query.ts#loadEnrichmentCandidates`,
 * scoped by the test source_id prefix so a shared schema's other rows can't
 * perturb the assertion (the real query is unscoped).
 */
async function loadCandidates(sql, { backfill = false } = {}) {
  const windowClause = backfill ? sql`` : sql`AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;
  return sql`
    SELECT DISTINCT c."headlining_artist_id" AS artist_id
    FROM ${sql(SCHEMA)}."concerts" c
    WHERE c."removed_at" IS NULL
      AND c."headlining_artist_id" IS NOT NULL
      ${windowClause}
      AND c."source_id" LIKE ${SOURCE_ID_PREFIX + '%'}
    ORDER BY c."headlining_artist_id" ASC
  `;
}

/**
 * OVERWRITE-UPSERT mirror of writer.ts#overwriteNeighbors (upsert arm). One row
 * per statement with an explicit `${sql.json(...)}` so the jsonb `neighbors`
 * column serializes unambiguously (postgres.js would otherwise coerce a JS
 * array to a Postgres array, not jsonb).
 */
async function upsertNeighbors(sql, rows) {
  const returned = [];
  for (const r of rows) {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}."artist_similar_artists" ("artist_id", "neighbors")
      VALUES (${r.artist_id}, ${sql.json(r.neighbors)})
      ON CONFLICT ("artist_id") DO UPDATE
        SET "neighbors" = excluded."neighbors", "updated_at" = now()
      RETURNING "artist_id"
    `;
    returned.push(row);
  }
  return returned;
}

/** Scoped DELETE mirror of writer.ts#overwriteNeighbors (delete arm). */
async function deleteNeighbors(sql, artistIds) {
  if (artistIds.length === 0) return [];
  return sql`
    DELETE FROM ${sql(SCHEMA)}."artist_similar_artists"
    WHERE "artist_id" = ANY(${artistIds})
    RETURNING "artist_id"
  `;
}

/**
 * UPSERT mirror of station-writer.ts#writeStationPlays (BS#1702). UPSERT-only,
 * no DELETE — a stale count is harmless.
 */
async function upsertStationPlays(sql, rows) {
  const returned = [];
  for (const r of rows) {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}."artist_station_plays" ("artist_id", "plays")
      VALUES (${r.artist_id}, ${r.plays})
      ON CONFLICT ("artist_id") DO UPDATE
        SET "plays" = excluded."plays", "updated_at" = now()
      RETURNING "artist_id"
    `;
    returned.push(row);
  }
  return returned;
}

describe('concerts similar-artists enrichment (BS#1626)', () => {
  let auth;
  let sql;
  let venueId;
  let enrichedArtistId;
  let unenrichedArtistId;
  let pastArtistId;
  let writerAId;
  let writerBId;

  const seedConcert = async (o) => {
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, headlining_artist_raw,
          headlining_artist_id, headlining_discogs_artist_id, removed_at, raw_data, scraped_at)
       VALUES ('triangle_shows', $1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, now())`,
      [
        SOURCE_ID_PREFIX + o.key,
        o.venue_id,
        o.starts_on,
        o.headlining_artist_raw,
        o.headlining_artist_id ?? null,
        o.headlining_discogs_artist_id ?? null,
        o.removed_at ?? null,
      ]
    );
  };

  const insertArtist = async (name, discogsId) => {
    const [row] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [name, discogsId]
    );
    return row.id;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    // Deleting the artists cascades to artist_similar_artists (ON DELETE
    // CASCADE), so no separate delete is needed for the neighbor rows. Delete by
    // the synthetic discogs_artist_id, NOT by name: the CI seed clone already
    // contains real artists with these WXYC names whose `library` rows FK to
    // `artists.id` (a name-based delete would hit those seed rows).
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE discogs_artist_id = ANY($1)`, [
      [DISCOGS_ENRICHED, DISCOGS_UNENRICHED, DISCOGS_PAST, DISCOGS_WRITER_A, DISCOGS_WRITER_B],
    ]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup();

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1626 Probe Room', 'Carrboro', 'NC', '300 E Main St') RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    enrichedArtistId = await insertArtist(ARTIST_ENRICHED, DISCOGS_ENRICHED);
    unenrichedArtistId = await insertArtist(ARTIST_UNENRICHED, DISCOGS_UNENRICHED);
    pastArtistId = await insertArtist(ARTIST_PAST, DISCOGS_PAST);
    // Writer-only artists (no concerts) — the OVERWRITE/DELETE half operates on
    // these so it can't add a neighbors row to a projection-half artist.
    writerAId = await insertArtist('BS1626 Writer A', DISCOGS_WRITER_A);
    writerBId = await insertArtist('BS1626 Writer B', DISCOGS_WRITER_B);

    // The enriched artist's persisted neighbors (what GET /concerts surfaces).
    await sql`
      INSERT INTO ${sql(SCHEMA)}."artist_similar_artists" ("artist_id", "neighbors")
      VALUES (${enrichedArtistId}, ${sql.json([
        { artist_id: 5121, weight: 4.83 },
        { artist_id: 88, weight: 2.1 },
      ])})
    `;
    // The enriched artist's persisted station-plays count (BS#1702). The
    // unenriched artist deliberately has NO row, so its station_plays is null.
    await sql`
      INSERT INTO ${sql(SCHEMA)}."artist_station_plays" ("artist_id", "plays")
      VALUES (${enrichedArtistId}, 312)
    `;

    // In-library, resolved + enriched, upcoming — TWO shows for the SAME artist
    // to prove DISTINCT collapse.
    await seedConcert({
      key: 'enriched-a',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: ARTIST_ENRICHED,
      headlining_artist_id: enrichedArtistId,
    });
    await seedConcert({
      key: 'enriched-b',
      venue_id: venueId,
      starts_on: IN_20,
      headlining_artist_raw: ARTIST_ENRICHED,
      headlining_artist_id: enrichedArtistId,
    });
    // In-library, resolved, unenriched, upcoming.
    await seedConcert({
      key: 'unenriched',
      venue_id: venueId,
      starts_on: IN_15,
      headlining_artist_raw: ARTIST_UNENRICHED,
      headlining_artist_id: unenrichedArtistId,
    });
    // Discogs-only lane: a Discogs id but NO headlining_artist_id → not in-library
    // → NOT a candidate (the affinity graph can't cover it).
    await seedConcert({
      key: 'discogs-only',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: 'Touring Act Absent From Library',
      headlining_discogs_artist_id: DISCOGS_ONLY,
    });
    // Unresolved headliner — no id either lane; never a candidate, similar null.
    await seedConcert({
      key: 'unresolved',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: 'Some Unresolved Billing & Another',
    });
    // In-library, resolved, PAST — nightly excludes (upcoming-only), backfill includes.
    await seedConcert({
      key: 'past',
      venue_id: venueId,
      starts_on: PAST,
      headlining_artist_raw: ARTIST_PAST,
      headlining_artist_id: pastArtistId,
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  describe('candidate selection (mirror of query.ts)', () => {
    it('selects in-library headliners only, deduped, excluding Discogs-only/unresolved/past', async () => {
      const rows = await loadCandidates(sql);
      const ids = rows.map((r) => Number(r.artist_id));

      // Included: the enriched (once, despite two shows) + the unenriched library artist.
      expect(ids).toContain(enrichedArtistId);
      expect(ids).toContain(unenrichedArtistId);
      // DISTINCT collapse: the two enriched shows yield one candidate.
      expect(ids.filter((id) => id === enrichedArtistId)).toHaveLength(1);
      // Excluded: the past show (outside the nightly upcoming window) and the
      // Discogs-only / unresolved lanes (no headlining_artist_id at all).
      expect(ids).not.toContain(pastArtistId);
    });

    it('excludes the Discogs-only headliner (no library FK → no library_artist_id to send)', async () => {
      // The Discogs-only concert has headlining_discogs_artist_id but no
      // headlining_artist_id, so it can never appear in the in-library cohort.
      // Assert the cohort is exactly the two in-library upcoming artists.
      const rows = await loadCandidates(sql);
      const ids = rows.map((r) => Number(r.artist_id)).sort((a, b) => a - b);
      expect(ids).toEqual([enrichedArtistId, unenrichedArtistId].sort((a, b) => a - b));
    });

    it('--backfill drops the upcoming-only window and includes the past resolved headliner', async () => {
      const nightly = (await loadCandidates(sql)).map((r) => Number(r.artist_id));
      const backfill = (await loadCandidates(sql, { backfill: true })).map((r) => Number(r.artist_id));
      expect(nightly).not.toContain(pastArtistId);
      expect(backfill).toContain(pastArtistId);
    });
  });

  describe('OVERWRITE writer (mirror of writer.ts)', () => {
    it('UPSERT overwrites an existing row (opposite of the genre DO-NOTHING)', async () => {
      const first = await upsertNeighbors(sql, [{ artist_id: writerAId, neighbors: [{ artist_id: 1, weight: 9 }] }]);
      expect(first).toHaveLength(1);

      // A second UPSERT with DIFFERENT neighbors OVERWRITES the row (DO UPDATE),
      // keeping neighbors current with the nightly graph rebuild.
      await upsertNeighbors(sql, [
        {
          artist_id: writerAId,
          neighbors: [
            { artist_id: 2, weight: 5 },
            { artist_id: 3, weight: 4 },
          ],
        },
      ]);
      const [persisted] = await sql.unsafe(
        `SELECT neighbors FROM "${SCHEMA}".artist_similar_artists WHERE artist_id = $1`,
        [writerAId]
      );
      expect(persisted.neighbors).toEqual([
        { artist_id: 2, weight: 5 },
        { artist_id: 3, weight: 4 },
      ]);
    });

    it('scoped DELETE clears an emptied row', async () => {
      // Seed a row, then delete it via the scoped id list.
      await upsertNeighbors(sql, [{ artist_id: writerBId, neighbors: [{ artist_id: 7, weight: 1 }] }]);
      const deleted = await deleteNeighbors(sql, [writerBId]);
      expect(deleted).toHaveLength(1);
      const remaining = await sql.unsafe(`SELECT 1 FROM "${SCHEMA}".artist_similar_artists WHERE artist_id = $1`, [
        writerBId,
      ]);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('station-plays UPSERT writer (BS#1702, mirror of station-writer.ts)', () => {
    it('UPSERT overwrites an existing station-plays row (UPSERT-only, no DELETE)', async () => {
      const first = await upsertStationPlays(sql, [{ artist_id: writerAId, plays: 100 }]);
      expect(first).toHaveLength(1);

      // A second UPSERT with a DIFFERENT count OVERWRITES the row (DO UPDATE),
      // keeping the play count current with the nightly graph.
      await upsertStationPlays(sql, [{ artist_id: writerAId, plays: 275 }]);
      const [persisted] = await sql.unsafe(`SELECT plays FROM "${SCHEMA}".artist_station_plays WHERE artist_id = $1`, [
        writerAId,
      ]);
      expect(Number(persisted.plays)).toBe(275);
    });
  });

  describe('GET /concerts similar_artists projection', () => {
    it('emits the joined similar_artists array for a resolved + enriched headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const enriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_ENRICHED);
      expect(enriched).toBeDefined();
      expect(enriched.similar_artists).toEqual([
        { artist_id: 5121, weight: 4.83 },
        { artist_id: 88, weight: 2.1 },
      ]);
    });

    it('emits null similar_artists for a resolved-but-unenriched headliner', async () => {
      // The unenriched library artist has a concert (IN_15) but no
      // artist_similar_artists row (the writer half uses separate writer-only
      // artists), so the LEFT JOIN misses and the field is null.
      const res = await auth.get(`/concerts?from=${IN_15}&to=${IN_15}`).expect(200);
      const unenriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_UNENRICHED);
      expect(unenriched).toBeDefined();
      expect(unenriched.similar_artists).toBeNull();
    });

    it('emits null similar_artists for an unresolved headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const unresolved = res.body.concerts.find((c) => c.headlining_artist_raw === 'Some Unresolved Billing & Another');
      expect(unresolved).toBeDefined();
      expect(unresolved.similar_artists).toBeNull();
    });

    it('emits null similar_artists for a Discogs-only headliner un-enriched in the discogs lane', async () => {
      // This spec never seeds a `discogs_artist_similar_artists` row, so the
      // Discogs-only headliner is un-enriched in BOTH lanes and its COALESCE is
      // null. The discogs lane populating this case is BS#1701's job — covered by
      // concerts-similar-artists-discogs-lane.spec.js, not here.
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const discogsOnly = res.body.concerts.find((c) => c.headlining_artist_raw === 'Touring Act Absent From Library');
      expect(discogsOnly).toBeDefined();
      expect(discogsOnly.similar_artists).toBeNull();
    });
  });

  describe('GET /concerts station_plays projection (BS#1702)', () => {
    it('emits the joined station_plays count for a resolved + enriched headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const enriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_ENRICHED);
      expect(enriched).toBeDefined();
      expect(enriched.station_plays).toBe(312);
    });

    it('emits null station_plays for a resolved-but-unenriched headliner', async () => {
      // The unenriched library artist has a concert (IN_15) but no
      // artist_station_plays row, so the LEFT JOIN misses and the field is null.
      const res = await auth.get(`/concerts?from=${IN_15}&to=${IN_15}`).expect(200);
      const unenriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_UNENRICHED);
      expect(unenriched).toBeDefined();
      expect(unenriched.station_plays).toBeNull();
    });

    it('emits null station_plays for an unresolved headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const unresolved = res.body.concerts.find((c) => c.headlining_artist_raw === 'Some Unresolved Billing & Another');
      expect(unresolved).toBeDefined();
      expect(unresolved.station_plays).toBeNull();
    });

    it('emits null station_plays for a Discogs-only headliner (no in-library id)', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const discogsOnly = res.body.concerts.find((c) => c.headlining_artist_raw === 'Touring Act Absent From Library');
      expect(discogsOnly).toBeDefined();
      expect(discogsOnly.station_plays).toBeNull();
    });

    // Regression guard for the lockstep `artist_station_plays` LEFT JOIN: the
    // by-id read selects the same `concertPageFields` projection, so a missing
    // join in `getConcertById` would 500 every by-id request (the BS#1694 class
    // of miss). Assert the by-id read projects station_plays for the same row.
    it('GET /concerts/:id projects station_plays for the enriched headliner', async () => {
      const list = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const enriched = list.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_ENRICHED);
      expect(enriched).toBeDefined();

      const byId = await request.get(`/concerts/${enriched.id}`).expect(200);
      expect(byId.body.id).toBe(enriched.id);
      expect(byId.body.station_plays).toBe(312);
    });
  });
});
