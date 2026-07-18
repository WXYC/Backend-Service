/**
 * Integration tests for the concerts genre-enrichment pipeline (BS#1624)
 * against a REAL Postgres (migration 0121 `artist_metadata` + the read-path
 * LEFT JOIN in apps/backend/services/concerts.service.ts).
 *
 * Two halves, both DB-backed:
 *
 *  1. The nightly enrichment's DB contract, validating the SQL the job issues:
 *     - candidate selection (`jobs/concerts-genre-enrichment/query.ts`): the
 *       COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)
 *       effective-id, the `artist_metadata` anti-join (unenriched only), the
 *       DISTINCT-ON dedupe, the upcoming-only window, and the `--backfill`
 *       window that drops it;
 *     - the UPSERT (`jobs/concerts-genre-enrichment/writer.ts`): ON CONFLICT
 *       DO NOTHING idempotency — a re-run inserts 0 and never overwrites.
 *  2. The read projection: `GET /concerts` emits `genres` for a resolved +
 *     enriched headliner and `null` when unresolved or un-enriched.
 *
 * Pure SQL for half 1 — does NOT import the TS job (the integration runner is
 * babel-jest with no TS support); the SQL here mirrors query.ts / writer.ts and
 * must follow when they change. Mirrors the sibling
 * `concerts-artist-lml-resolver-writer.spec.js` in shape.
 *
 * WXYC-representative headliners (Juana Molina, Stereolab, Chuquimamani-Condori)
 * per the org fixture convention. Needs CI to run: requires the Docker
 * integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1624:';
const VENUE_SLUG = 'bs1624-probe-room';

// Stable, high Discogs ids so they never collide with seeded fixture data.
const DISCOGS_ENRICHED = 91624001; // Lane A (library FK), already has an artist_metadata row.
const DISCOGS_EXTERNAL = 91624002; // Lane B (headlining_discogs_artist_id only), unenriched.
const DISCOGS_LIBRARY_UNENRICHED = 91624003; // Lane A (library FK), unenriched.
const DISCOGS_PAST = 91624004; // Lane B, unenriched, PAST show (nightly excludes; backfill includes).
// Ids used only by the idempotency half, so they can't perturb the other tests.
const DISCOGS_UPSERT_A = 91624901;
const DISCOGS_UPSERT_B = 91624902;

const ARTIST_ENRICHED = 'Juana Molina'; // library artist, resolved + enriched
const ARTIST_LIBRARY_UNENRICHED = 'Stereolab'; // library artist, resolved, not yet enriched

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
 * `jobs/concerts-genre-enrichment/query.ts#loadEnrichmentCandidates`, scoped by
 * the test source_id prefix so a shared schema's other rows can't perturb the
 * assertion (the real query is unscoped).
 */
async function loadCandidates(sql, { backfill = false } = {}) {
  const windowClause = backfill ? sql`` : sql`AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;
  return sql`
    SELECT DISTINCT ON (eff.discogs_artist_id)
      eff.discogs_artist_id AS discogs_artist_id,
      eff.artist_name AS artist_name
    FROM (
      SELECT
        COALESCE(c."headlining_discogs_artist_id", a."discogs_artist_id") AS discogs_artist_id,
        COALESCE(a."artist_name", c."headlining_artist_raw") AS artist_name
      FROM ${sql(SCHEMA)}."concerts" c
      LEFT JOIN ${sql(SCHEMA)}."artists" a ON a."id" = c."headlining_artist_id"
      WHERE c."removed_at" IS NULL
        ${windowClause}
        AND COALESCE(c."headlining_discogs_artist_id", a."discogs_artist_id") IS NOT NULL
        AND c."source_id" LIKE ${SOURCE_ID_PREFIX + '%'}
    ) eff
    LEFT JOIN ${sql(SCHEMA)}."artist_metadata" am ON am."discogs_artist_id" = eff.discogs_artist_id
    WHERE am."discogs_artist_id" IS NULL
    ORDER BY eff.discogs_artist_id ASC
  `;
}

/** UPSERT mirror of `jobs/concerts-genre-enrichment/writer.ts#upsertArtistGenres`. */
async function upsertArtistGenres(sql, rows) {
  if (rows.length === 0) return [];
  return sql`
    INSERT INTO ${sql(SCHEMA)}."artist_metadata" ${sql(rows, 'discogs_artist_id', 'genres', 'styles')}
    ON CONFLICT ("discogs_artist_id") DO NOTHING
    RETURNING "discogs_artist_id"
  `;
}

describe('concerts genre enrichment (BS#1624)', () => {
  let auth;
  let sql;
  let venueId;
  let enrichedArtistId;
  let libraryUnenrichedArtistId;

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

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    // Delete by the test's synthetic discogs_artist_id, NOT by name: the CI seed
    // clone already contains real artists with these WXYC names (Juana Molina,
    // Stereolab) whose `library` rows FK-reference `artists.id`, so a name-based
    // delete hits those seed rows (library_artist_id_artists_id_fk violation).
    // The synthetic ids (9162400x) exist only in this test.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE discogs_artist_id = ANY($1)`, [
      [DISCOGS_ENRICHED, DISCOGS_LIBRARY_UNENRICHED],
    ]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = ANY($1)`, [
      [
        DISCOGS_ENRICHED,
        DISCOGS_EXTERNAL,
        DISCOGS_LIBRARY_UNENRICHED,
        DISCOGS_PAST,
        DISCOGS_UPSERT_A,
        DISCOGS_UPSERT_B,
      ],
    ]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup();

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1624 Probe Room', 'Carrboro', 'NC', '300 E Main St') RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    // Library artist, resolved + ENRICHED (has an artist_metadata row).
    const [a1] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [ARTIST_ENRICHED, DISCOGS_ENRICHED]
    );
    enrichedArtistId = a1.id;

    // Library artist, resolved but NOT yet enriched.
    const [a2] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [ARTIST_LIBRARY_UNENRICHED, DISCOGS_LIBRARY_UNENRICHED]
    );
    libraryUnenrichedArtistId = a2.id;

    // The enriched artist's persisted genres (what GET /concerts should surface).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles)
       VALUES ($1, $2, $3)`,
      [DISCOGS_ENRICHED, ['Rock', 'Electronic'], ['Folktronica']]
    );

    // Lane A, resolved + enriched, upcoming.
    await seedConcert({
      key: 'enriched-library',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: ARTIST_ENRICHED,
      headlining_artist_id: enrichedArtistId,
    });
    // Lane A, resolved, unenriched, upcoming.
    await seedConcert({
      key: 'unenriched-library',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: ARTIST_LIBRARY_UNENRICHED,
      headlining_artist_id: libraryUnenrichedArtistId,
    });
    // Lane B (external Discogs id only), unenriched, upcoming — TWO shows for
    // the SAME artist to prove DISTINCT-ON dedupe.
    await seedConcert({
      key: 'external-a',
      venue_id: venueId,
      starts_on: IN_15,
      headlining_artist_raw: 'Chuquimamani-Condori',
      headlining_discogs_artist_id: DISCOGS_EXTERNAL,
    });
    await seedConcert({
      key: 'external-b',
      venue_id: venueId,
      starts_on: IN_20,
      headlining_artist_raw: 'Chuquimamani-Condori',
      headlining_discogs_artist_id: DISCOGS_EXTERNAL,
    });
    // Unresolved headliner — no id either lane; never a candidate, genres null.
    await seedConcert({
      key: 'unresolved',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: 'Some Unresolved Billing & Another',
    });
    // Lane B, unenriched, PAST — nightly excludes (upcoming-only), backfill includes.
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
    it('selects resolved + unenriched headliners (both lanes), deduped, excluding enriched/unresolved', async () => {
      const rows = await loadCandidates(sql);
      const ids = rows.map((r) => Number(r.discogs_artist_id));

      // Included: Lane B external (once, despite two shows) + Lane A unenriched library.
      expect(ids).toContain(DISCOGS_EXTERNAL);
      expect(ids).toContain(DISCOGS_LIBRARY_UNENRICHED);
      // Excluded: already enriched (has artist_metadata row), unresolved (no id),
      // and the past show (outside the nightly upcoming window).
      expect(ids).not.toContain(DISCOGS_ENRICHED);
      expect(ids).not.toContain(DISCOGS_PAST);
      // DISTINCT-ON dedupe: the two external shows collapse to one candidate.
      expect(ids.filter((id) => id === DISCOGS_EXTERNAL)).toHaveLength(1);
    });

    it('carries a usable name — the canonical artists.artist_name for a library headliner', async () => {
      const rows = await loadCandidates(sql);
      const libraryRow = rows.find((r) => Number(r.discogs_artist_id) === DISCOGS_LIBRARY_UNENRICHED);
      expect(libraryRow.artist_name).toBe(ARTIST_LIBRARY_UNENRICHED);
    });

    it('--backfill drops the upcoming-only window and includes the past resolved headliner', async () => {
      const nightly = (await loadCandidates(sql)).map((r) => Number(r.discogs_artist_id));
      const backfill = (await loadCandidates(sql, { backfill: true })).map((r) => Number(r.discogs_artist_id));
      expect(nightly).not.toContain(DISCOGS_PAST);
      expect(backfill).toContain(DISCOGS_PAST);
    });
  });

  describe('UPSERT idempotency (mirror of writer.ts)', () => {
    it('inserts new rows, and a re-run inserts 0 without overwriting a collected row', async () => {
      const rows = [
        { discogs_artist_id: DISCOGS_UPSERT_A, genres: ['Jazz'], styles: ['Big Band'] },
        { discogs_artist_id: DISCOGS_UPSERT_B, genres: [], styles: [] },
      ];

      const firstRun = await upsertArtistGenres(sql, rows);
      expect(firstRun).toHaveLength(2);

      // Re-run the same batch (idempotency): ON CONFLICT DO NOTHING → 0 inserts.
      const secondRun = await upsertArtistGenres(sql, rows);
      expect(secondRun).toHaveLength(0);

      // A conflicting re-run with DIFFERENT genres must NOT overwrite the row.
      await upsertArtistGenres(sql, [{ discogs_artist_id: DISCOGS_UPSERT_A, genres: ['Pop'], styles: ['Synth-pop'] }]);
      const [persisted] = await sql.unsafe(
        `SELECT genres, styles FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = $1`,
        [DISCOGS_UPSERT_A]
      );
      expect(persisted.genres).toEqual(['Jazz']);
      expect(persisted.styles).toEqual(['Big Band']);
    });
  });

  describe('GET /concerts genres projection', () => {
    it('emits the joined genres array for a resolved + enriched headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const enriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_ENRICHED);
      expect(enriched).toBeDefined();
      expect(enriched.genres).toEqual(['Rock', 'Electronic']);
    });

    it('emits null genres for a resolved-but-unenriched headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const unenriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_LIBRARY_UNENRICHED);
      expect(unenriched).toBeDefined();
      expect(unenriched.genres).toBeNull();
    });

    it('emits null genres for an unresolved headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const unresolved = res.body.concerts.find((c) => c.headlining_artist_raw === 'Some Unresolved Billing & Another');
      expect(unresolved).toBeDefined();
      expect(unresolved.genres).toBeNull();
    });
  });
});
