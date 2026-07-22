/**
 * Integration tests for the DISCOGS lane of the concerts similar-artists
 * enrichment pipeline (BS#1701) against a REAL Postgres (migration
 * `discogs_artist_similar_artists` + the second COALESCE LEFT JOIN in
 * apps/backend/services/concerts.service.ts).
 *
 * The BS#1626 sibling spec (concerts-similar-artists-enrichment.spec.js) covers
 * the LIBRARY lane; this covers the new lane that surfaces similar-artists for
 * Discogs-only touring headliners (`headlining_artist_id IS NULL AND
 * headlining_discogs_artist_id IS NOT NULL` — BS#1614's LML-minted artists
 * absent from the WXYC library). Three halves, all DB-backed:
 *
 *  1. The discogs-lane candidate query (mirror of discogs-query.ts): DISCOGS-ONLY
 *     headliners, DISTINCT on `headlining_discogs_artist_id`, upcoming-only
 *     window + `--backfill`, EXCLUDING in-library and unresolved headliners.
 *  2. The OVERWRITE writer (mirror of discogs-writer.ts) on
 *     `discogs_artist_similar_artists`: UPSERT overwrites, scoped DELETE clears.
 *  3. The read projection: `GET /concerts` (+ by-id parity) emits
 *     `similar_artists` for a Discogs-only enriched headliner via the COALESCE,
 *     and the LIBRARY lane WINS the COALESCE when both lanes have a row.
 *
 * Pure SQL for halves 1-2 — does NOT import the TS job (the integration runner
 * is babel-jest, no TS); the SQL mirrors discogs-query.ts / discogs-writer.ts
 * and must follow when they change. Mirrors the BS#1626 sibling spec in shape.
 *
 * WXYC-representative headliners per the org fixture convention. Requires the
 * Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1701:';
const VENUE_SLUG = 'bs1701-probe-room';

// Stable, high Discogs ids so they never collide with seeded fixture data.
const DISCOGS_ENRICHED = 91701001; // Discogs-only, enriched in the discogs lane
const DISCOGS_UNENRICHED = 91701002; // Discogs-only, no discogs-lane row → null
const DISCOGS_PAST = 91701003; // Discogs-only, PAST show (nightly excludes)
const DISCOGS_BOTH = 91701004; // in-library artist whose Discogs id ALSO has a discogs-lane row
// Writer-only Discogs ids: no concerts, used solely by the OVERWRITE/DELETE half.
const DISCOGS_WRITER_A = 91701901;
const DISCOGS_WRITER_B = 91701902;

// The Finding-1 regression guard: an in-library headliner with a NULL
// discogs_artist_id (23 of 38 real ones). Its effective Discogs id is NULL, so
// the discogs-lane join can never match — the COALESCE must fall through to the
// library lane. A synthetic name (never in the seed clone) so the cleanup can
// safely delete it by name (it has no discogs_artist_id to delete by).
const ARTIST_NULL_DISCOGS = 'BS1701 In-Library Null Discogs';
const NULL_DISCOGS_LANE_NEIGHBORS = [{ artist_id: 8003, weight: 7.7 }];

const RAW_ENRICHED = 'Touring Act With Neighbors'; // Discogs-only, enriched
const RAW_UNENRICHED = 'Touring Act No Neighbors'; // Discogs-only, un-enriched
const RAW_PAST = 'Touring Act Past'; // Discogs-only, past
const ARTIST_BOTH = 'BS1701 In-Library Both'; // in-library headliner for the COALESCE-precedence case

// Neighbor lists (WXYC catalog ids in both lanes).
const DISCOGS_NEIGHBORS = [
  { artist_id: 7001, weight: 5.12 },
  { artist_id: 7002, weight: 3.4 },
];
const LIBRARY_LANE_NEIGHBORS = [{ artist_id: 8001, weight: 9.9 }];
const DISCOGS_LANE_NEIGHBORS_FOR_BOTH = [{ artist_id: 8002, weight: 1.1 }];

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
 * Discogs-lane candidate query — a faithful mirror of
 * `jobs/concerts-similar-artists-enrichment/discogs-query.ts#loadDiscogsEnrichmentCandidates`,
 * scoped by the test source_id prefix so a shared schema's other rows can't
 * perturb the assertion (the real query is unscoped).
 */
async function loadDiscogsCandidates(sql, { backfill = false } = {}) {
  const windowClause = backfill ? sql`` : sql`AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;
  return sql`
    SELECT DISTINCT c."headlining_discogs_artist_id" AS discogs_artist_id
    FROM ${sql(SCHEMA)}."concerts" c
    WHERE c."removed_at" IS NULL
      AND c."headlining_artist_id" IS NULL
      AND c."headlining_discogs_artist_id" IS NOT NULL
      ${windowClause}
      AND c."source_id" LIKE ${SOURCE_ID_PREFIX + '%'}
    ORDER BY c."headlining_discogs_artist_id" ASC
  `;
}

/** OVERWRITE-UPSERT mirror of discogs-writer.ts#overwriteDiscogsNeighbors (upsert arm). */
async function upsertDiscogsNeighbors(sql, rows) {
  const returned = [];
  for (const r of rows) {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}."discogs_artist_similar_artists" ("discogs_artist_id", "neighbors")
      VALUES (${r.discogs_artist_id}, ${sql.json(r.neighbors)})
      ON CONFLICT ("discogs_artist_id") DO UPDATE
        SET "neighbors" = excluded."neighbors", "updated_at" = now()
      RETURNING "discogs_artist_id"
    `;
    returned.push(row);
  }
  return returned;
}

/** Scoped DELETE mirror of discogs-writer.ts#overwriteDiscogsNeighbors (delete arm). */
async function deleteDiscogsNeighbors(sql, discogsIds) {
  if (discogsIds.length === 0) return [];
  return sql`
    DELETE FROM ${sql(SCHEMA)}."discogs_artist_similar_artists"
    WHERE "discogs_artist_id" = ANY(${discogsIds})
    RETURNING "discogs_artist_id"
  `;
}

describe('concerts similar-artists discogs lane (BS#1701)', () => {
  let auth;
  let sql;
  let venueId;
  let bothArtistId;
  let nullDiscogsArtistId;

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
    // discogs_artist_similar_artists has NO FK (bare Discogs PK), so unlike the
    // library lane it does not cascade from artists — delete the rows explicitly.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".discogs_artist_similar_artists WHERE discogs_artist_id = ANY($1)`, [
      [DISCOGS_ENRICHED, DISCOGS_UNENRICHED, DISCOGS_PAST, DISCOGS_BOTH, DISCOGS_WRITER_A, DISCOGS_WRITER_B],
    ]);
    // Delete the in-library "both" artist by its synthetic discogs_artist_id (its
    // library-lane row cascades on the artist delete).
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE discogs_artist_id = ANY($1)`, [[DISCOGS_BOTH]]);
    // The NULL-discogs artist has no discogs_artist_id to key on — delete by its
    // synthetic name (safe: no seed-clone artist carries this made-up name). Its
    // library-lane row cascades.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1`, [ARTIST_NULL_DISCOGS]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup();

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1701 Probe Room', 'Carrboro', 'NC', '300 E Main St') RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    // In-library artist for the COALESCE-precedence case: its Discogs id
    // (DISCOGS_BOTH) is what the read path resolves `effectiveHeadlinerDiscogsId`
    // to, so a discogs-lane row keyed on DISCOGS_BOTH could collide with its
    // library-lane row — the COALESCE must prefer the library lane.
    bothArtistId = await insertArtist(ARTIST_BOTH, DISCOGS_BOTH);
    // In-library artist with a NULL discogs_artist_id (the Finding-1 cohort).
    nullDiscogsArtistId = await insertArtist(ARTIST_NULL_DISCOGS, null);

    // Discogs-lane neighbor rows.
    await upsertDiscogsNeighbors(sql, [
      { discogs_artist_id: DISCOGS_ENRICHED, neighbors: DISCOGS_NEIGHBORS },
      { discogs_artist_id: DISCOGS_BOTH, neighbors: DISCOGS_LANE_NEIGHBORS_FOR_BOTH },
    ]);
    // Library-lane neighbor row for the in-library "both" artist (library lane
    // wins the COALESCE).
    await sql`
      INSERT INTO ${sql(SCHEMA)}."artist_similar_artists" ("artist_id", "neighbors")
      VALUES (${bothArtistId}, ${sql.json(LIBRARY_LANE_NEIGHBORS)})
    `;
    // Library-lane row for the NULL-discogs artist (its effective Discogs id is
    // NULL, so ONLY the library lane can surface its neighbors).
    await sql`
      INSERT INTO ${sql(SCHEMA)}."artist_similar_artists" ("artist_id", "neighbors")
      VALUES (${nullDiscogsArtistId}, ${sql.json(NULL_DISCOGS_LANE_NEIGHBORS)})
    `;

    // Discogs-only, enriched, upcoming — TWO shows for the SAME Discogs id to
    // prove DISTINCT collapse.
    await seedConcert({
      key: 'enriched-a',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: RAW_ENRICHED,
      headlining_discogs_artist_id: DISCOGS_ENRICHED,
    });
    await seedConcert({
      key: 'enriched-b',
      venue_id: venueId,
      starts_on: IN_15,
      headlining_artist_raw: RAW_ENRICHED,
      headlining_discogs_artist_id: DISCOGS_ENRICHED,
    });
    // Discogs-only, upcoming, NOT enriched in the discogs lane → null.
    await seedConcert({
      key: 'unenriched',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: RAW_UNENRICHED,
      headlining_discogs_artist_id: DISCOGS_UNENRICHED,
    });
    // In-library headliner whose effective Discogs id ALSO has a discogs-lane row
    // — the COALESCE-precedence case.
    await seedConcert({
      key: 'both',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: ARTIST_BOTH,
      headlining_artist_id: bothArtistId,
    });
    // In-library headliner with a NULL discogs_artist_id — the COALESCE must fall
    // through to the library lane (the discogs join can never match a NULL key).
    await seedConcert({
      key: 'null-discogs',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: ARTIST_NULL_DISCOGS,
      headlining_artist_id: nullDiscogsArtistId,
    });
    // Discogs-only, PAST — nightly excludes (upcoming-only), backfill includes.
    await seedConcert({
      key: 'past',
      venue_id: venueId,
      starts_on: PAST,
      headlining_artist_raw: RAW_PAST,
      headlining_discogs_artist_id: DISCOGS_PAST,
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  describe('discogs-lane candidate selection (mirror of discogs-query.ts)', () => {
    it('selects Discogs-only headliners, deduped, excluding in-library/unresolved/past', async () => {
      const rows = await loadDiscogsCandidates(sql);
      const ids = rows.map((r) => Number(r.discogs_artist_id));

      // Included: the enriched (once, despite two shows) + the un-enriched
      // Discogs-only headliner.
      expect(ids).toContain(DISCOGS_ENRICHED);
      expect(ids).toContain(DISCOGS_UNENRICHED);
      // DISTINCT collapse: the two enriched shows yield one candidate.
      expect(ids.filter((id) => id === DISCOGS_ENRICHED)).toHaveLength(1);
      // Excluded: the in-library "both" artist (has headlining_artist_id → the
      // LIBRARY lane's cohort, not this one) and the past show (nightly window).
      expect(ids).not.toContain(DISCOGS_BOTH);
      expect(ids).not.toContain(DISCOGS_PAST);
    });

    it('partitions cleanly against the library lane (the in-library artist is never a discogs candidate)', async () => {
      // The two cohorts must be disjoint: a headliner with a headlining_artist_id
      // belongs to the library lane and must NEVER appear here, even though its
      // artists row carries a discogs_artist_id.
      const rows = await loadDiscogsCandidates(sql, { backfill: true });
      const ids = rows.map((r) => Number(r.discogs_artist_id));
      expect(ids).not.toContain(DISCOGS_BOTH);
    });

    it('--backfill drops the upcoming-only window and includes the past Discogs-only headliner', async () => {
      const nightly = (await loadDiscogsCandidates(sql)).map((r) => Number(r.discogs_artist_id));
      const backfill = (await loadDiscogsCandidates(sql, { backfill: true })).map((r) => Number(r.discogs_artist_id));
      expect(nightly).not.toContain(DISCOGS_PAST);
      expect(backfill).toContain(DISCOGS_PAST);
    });
  });

  describe('discogs-lane OVERWRITE writer (mirror of discogs-writer.ts)', () => {
    it('UPSERT overwrites an existing row (keeps neighbors current with the graph)', async () => {
      const first = await upsertDiscogsNeighbors(sql, [
        { discogs_artist_id: DISCOGS_WRITER_A, neighbors: [{ artist_id: 1, weight: 9 }] },
      ]);
      expect(first).toHaveLength(1);

      await upsertDiscogsNeighbors(sql, [
        {
          discogs_artist_id: DISCOGS_WRITER_A,
          neighbors: [
            { artist_id: 2, weight: 5 },
            { artist_id: 3, weight: 4 },
          ],
        },
      ]);
      const [persisted] = await sql.unsafe(
        `SELECT neighbors FROM "${SCHEMA}".discogs_artist_similar_artists WHERE discogs_artist_id = $1`,
        [DISCOGS_WRITER_A]
      );
      expect(persisted.neighbors).toEqual([
        { artist_id: 2, weight: 5 },
        { artist_id: 3, weight: 4 },
      ]);
    });

    it('scoped DELETE clears an emptied row', async () => {
      await upsertDiscogsNeighbors(sql, [
        { discogs_artist_id: DISCOGS_WRITER_B, neighbors: [{ artist_id: 7, weight: 1 }] },
      ]);
      const deleted = await deleteDiscogsNeighbors(sql, [DISCOGS_WRITER_B]);
      expect(deleted).toHaveLength(1);
      const remaining = await sql.unsafe(
        `SELECT 1 FROM "${SCHEMA}".discogs_artist_similar_artists WHERE discogs_artist_id = $1`,
        [DISCOGS_WRITER_B]
      );
      expect(remaining).toHaveLength(0);
    });
  });

  describe('GET /concerts similar_artists projection (COALESCE lanes)', () => {
    it('emits the joined similar_artists for a Discogs-only enriched headliner (discogs lane)', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const enriched = res.body.concerts.find((c) => c.headlining_artist_raw === RAW_ENRICHED);
      expect(enriched).toBeDefined();
      expect(enriched.headlining_artist_id).toBeNull(); // truly Discogs-only
      expect(enriched.similar_artists).toEqual(DISCOGS_NEIGHBORS);
    });

    it('emits null similar_artists for a Discogs-only headliner un-enriched in the discogs lane', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const unenriched = res.body.concerts.find((c) => c.headlining_artist_raw === RAW_UNENRICHED);
      expect(unenriched).toBeDefined();
      expect(unenriched.similar_artists).toBeNull();
    });

    it('LIBRARY lane WINS the COALESCE when both lanes have a row for the same headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const both = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_BOTH);
      expect(both).toBeDefined();
      // Library lane keyed on artists.id; discogs lane keyed on the same effective
      // Discogs id. COALESCE(library, discogs) must return the LIBRARY list.
      expect(both.similar_artists).toEqual(LIBRARY_LANE_NEIGHBORS);
      expect(both.similar_artists).not.toEqual(DISCOGS_LANE_NEIGHBORS_FOR_BOTH);
    });

    it('an in-library headliner with a NULL discogs_artist_id STILL surfaces its library-lane neighbors (Finding-1 non-regression)', async () => {
      // The regression the two-lane design exists to prevent: re-keying the
      // library lane on the Discogs id would drop this headliner (its effective
      // Discogs id is NULL). The COALESCE(library, discogs) must still return the
      // library list — the discogs lane simply can't match a NULL key.
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const nullDiscogs = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_NULL_DISCOGS);
      expect(nullDiscogs).toBeDefined();
      expect(nullDiscogs.headlining_artist_id).toBe(nullDiscogsArtistId);
      expect(nullDiscogs.similar_artists).toEqual(NULL_DISCOGS_LANE_NEIGHBORS);
    });

    it('by-id read (GET /concerts/:id) surfaces the same discogs-lane similar_artists (parity)', async () => {
      // BS#1694 parity: the by-id projection must join both lanes exactly like the
      // list, or Drizzle throws on the shared projection referencing an unjoined
      // table. Fetch the id from the list, then hit the public by-id route.
      const list = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const enriched = list.body.concerts.find((c) => c.headlining_artist_raw === RAW_ENRICHED);
      expect(enriched).toBeDefined();
      const byId = await request.get(`/concerts/${enriched.id}`).expect(200);
      expect(byId.body.similar_artists).toEqual(DISCOGS_NEIGHBORS);
    });
  });
});
