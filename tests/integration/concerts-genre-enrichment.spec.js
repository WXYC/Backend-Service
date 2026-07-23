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
const ARTIST_BIO = 'Argentine singer-songwriter known for genre-blurring electro-folk records.';

// BS#1734 bio-backfill fixtures: genres-only artist_metadata rows with artist_bio NULL.
const DISCOGS_BIO_NULL_LIB = 91624005; // library headliner (name via artists.artist_name), genres-only, bio NULL
const DISCOGS_BIO_NULL_EXT = 91624006; // Discogs-only headliner (name via freshest non-removed concert), bio NULL
const DISCOGS_BIO_FILL = 91624007; // dedicated mutable null-bio row for the fill test
const ARTIST_BIO_NULL_LIB = 'Hermanos Gutiérrez';
const ARTIST_BIO_FILL = 'Nilüfer Yanya';
const BIO_EXT_ACTIVE_RAW = 'Csillagrablók'; // freshest ACTIVE billing for the Discogs-only headliner

// BS#1746 regression: `artists.discogs_artist_id` is not unique, so two library
// rows can share one Discogs id. Both `loadEnrichmentCandidates` and
// `loadBioBackfillCandidates` LEFT JOIN artists on that non-unique column, so
// without a DISTINCT-ON tiebreak a shared id fans out to one candidate row per
// duplicate `artists` row — which then crashes the writer's multi-row UPSERT
// ("ON CONFLICT DO UPDATE command cannot affect row a second time").
const DISCOGS_BIO_NULL_DUPE = 91624008;
const ARTIST_BIO_NULL_DUPE_A = 'Chuquimamani-Condori'; // lower artists.id — wins the a.id ASC tiebreak
const ARTIST_BIO_NULL_DUPE_B = 'Duke Ellington & John Coltrane'; // higher artists.id, same discogs_artist_id

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
    INSERT INTO ${sql(SCHEMA)}."artist_metadata" ${sql(rows, 'discogs_artist_id', 'genres', 'styles', 'artist_bio')}
    ON CONFLICT ("discogs_artist_id") DO NOTHING
    RETURNING "discogs_artist_id"
  `;
}

/**
 * Bio-backfill candidate mirror of
 * `jobs/concerts-genre-enrichment/query.ts#loadBioBackfillCandidates` (BS#1734,
 * DISTINCT-ON dedupe added BS#1746), scoped to the test's synthetic ids so the
 * shared CI schema's other null-bio rows can't perturb the assertions (the real
 * query is unscoped). Exercises the `LATERAL … LIMIT 1` name resolution:
 * freshest NON-removed concert billing. `artists.discogs_artist_id` is NOT
 * unique, so the `LEFT JOIN artists` can fan one `am` row out to several —
 * `DISTINCT ON (am.discogs_artist_id)` + a deterministic `a.id ASC NULLS LAST`
 * tiebreak collapses that back to one candidate per artist_metadata row.
 */
async function loadBioBackfillCandidates(sql, ids) {
  return sql`
    SELECT DISTINCT ON (am."discogs_artist_id")
      am."discogs_artist_id" AS discogs_artist_id,
      COALESCE(a."artist_name", c."headlining_artist_raw") AS artist_name
    FROM ${sql(SCHEMA)}."artist_metadata" am
    LEFT JOIN ${sql(SCHEMA)}."artists" a ON a."discogs_artist_id" = am."discogs_artist_id"
    LEFT JOIN LATERAL (
      SELECT cc."headlining_artist_raw"
      FROM ${sql(SCHEMA)}."concerts" cc
      WHERE (cc."headlining_discogs_artist_id" = am."discogs_artist_id"
             OR cc."headlining_artist_id" = a."id")
        AND cc."removed_at" IS NULL
        AND cc."headlining_artist_raw" IS NOT NULL
      ORDER BY cc."starts_on" DESC NULLS LAST, cc."id" DESC
      LIMIT 1
    ) c ON TRUE
    WHERE am."artist_bio" IS NULL
      AND COALESCE(a."artist_name", c."headlining_artist_raw") IS NOT NULL
      AND am."discogs_artist_id" = ANY(${ids})
    ORDER BY am."discogs_artist_id" ASC, a."id" ASC NULLS LAST
  `;
}

/** Fill-null bio UPDATE mirror of `writer.ts#applyBioBackfill` (BS#1734). */
async function applyBioBackfill(sql, rows) {
  if (rows.length === 0) return [];
  return sql`
    INSERT INTO ${sql(SCHEMA)}."artist_metadata" ${sql(rows, 'discogs_artist_id', 'genres', 'styles', 'artist_bio')}
    ON CONFLICT ("discogs_artist_id") DO UPDATE
      SET "artist_bio" = excluded."artist_bio", "updated_at" = NOW()
      WHERE ${sql(SCHEMA)}."artist_metadata"."artist_bio" IS NULL
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
      [DISCOGS_ENRICHED, DISCOGS_LIBRARY_UNENRICHED, DISCOGS_BIO_NULL_LIB, DISCOGS_BIO_FILL, DISCOGS_BIO_NULL_DUPE],
    ]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = ANY($1)`, [
      [
        DISCOGS_ENRICHED,
        DISCOGS_EXTERNAL,
        DISCOGS_LIBRARY_UNENRICHED,
        DISCOGS_PAST,
        DISCOGS_UPSERT_A,
        DISCOGS_UPSERT_B,
        DISCOGS_BIO_NULL_LIB,
        DISCOGS_BIO_NULL_EXT,
        DISCOGS_BIO_FILL,
        DISCOGS_BIO_NULL_DUPE,
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

    // The enriched artist's persisted genres + bio (what GET /concerts should surface).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles, artist_bio)
       VALUES ($1, $2, $3, $4)`,
      [DISCOGS_ENRICHED, ['Rock', 'Electronic'], ['Folktronica'], ARTIST_BIO]
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

    // --- BS#1734 bio-backfill fixtures: genres-only rows with artist_bio NULL. ---

    // Library headliner: has an artists row (name resolves via artists.artist_name)
    // and an artist_metadata row WITH genres but a NULL bio.
    const [a3] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [ARTIST_BIO_NULL_LIB, DISCOGS_BIO_NULL_LIB]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles, artist_bio)
       VALUES ($1, $2, $3, NULL)`,
      [DISCOGS_BIO_NULL_LIB, ['Ambient'], []]
    );
    await seedConcert({
      key: 'bio-null-lib',
      venue_id: venueId,
      starts_on: IN_15,
      headlining_artist_raw: ARTIST_BIO_NULL_LIB,
      headlining_artist_id: a3.id,
    });

    // Discogs-only headliner: NO artists row, genres-only artist_metadata row with
    // NULL bio. Name must resolve to the freshest NON-removed concert billing —
    // three concerts prove both the removed_at exclusion and the DESC ordering:
    //   IN_20 REMOVED (latest date, but excluded), IN_15 ACTIVE (the winner),
    //   IN_10 ACTIVE (older, loses the tie-break).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles, artist_bio)
       VALUES ($1, $2, $3, NULL)`,
      [DISCOGS_BIO_NULL_EXT, [], []]
    );
    await seedConcert({
      key: 'bio-ext-removed',
      venue_id: venueId,
      starts_on: IN_20,
      headlining_artist_raw: 'Stale Removed Billing',
      headlining_discogs_artist_id: DISCOGS_BIO_NULL_EXT,
      removed_at: '2020-01-01T00:00:00Z',
    });
    await seedConcert({
      key: 'bio-ext-active',
      venue_id: venueId,
      starts_on: IN_15,
      headlining_artist_raw: BIO_EXT_ACTIVE_RAW,
      headlining_discogs_artist_id: DISCOGS_BIO_NULL_EXT,
    });
    await seedConcert({
      key: 'bio-ext-active-older',
      venue_id: venueId,
      starts_on: IN_10,
      headlining_artist_raw: 'Older Active Billing',
      headlining_discogs_artist_id: DISCOGS_BIO_NULL_EXT,
    });

    // BS#1746 regression: two `artists` rows sharing one discogs_artist_id (the
    // column is not unique). One genres-only, null-bio `artist_metadata` row,
    // but the LEFT JOIN artists on that shared id must not fan it out to two
    // candidates.
    // Insertion order matters: the lower-id row (A) must be inserted first so
    // the test can assert the deterministic `a.id ASC` tiebreak deterministically.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2)`,
      [ARTIST_BIO_NULL_DUPE_A, DISCOGS_BIO_NULL_DUPE]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2)`,
      [ARTIST_BIO_NULL_DUPE_B, DISCOGS_BIO_NULL_DUPE]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles, artist_bio)
       VALUES ($1, $2, $3, NULL)`,
      [DISCOGS_BIO_NULL_DUPE, ['Folk'], []]
    );

    // Dedicated mutable null-bio row for the fill test (kept off the load-test ids).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [ARTIST_BIO_FILL, DISCOGS_BIO_FILL]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_metadata (discogs_artist_id, genres, styles, artist_bio)
       VALUES ($1, $2, $3, NULL)`,
      [DISCOGS_BIO_FILL, ['Jazz'], []]
    );
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
        {
          discogs_artist_id: DISCOGS_UPSERT_A,
          genres: ['Jazz'],
          styles: ['Big Band'],
          artist_bio: 'A big band jazz outfit.',
        },
        { discogs_artist_id: DISCOGS_UPSERT_B, genres: [], styles: [], artist_bio: null },
      ];

      const firstRun = await upsertArtistGenres(sql, rows);
      expect(firstRun).toHaveLength(2);

      // Re-run the same batch (idempotency): ON CONFLICT DO NOTHING → 0 inserts.
      const secondRun = await upsertArtistGenres(sql, rows);
      expect(secondRun).toHaveLength(0);

      // A conflicting re-run with DIFFERENT genres/bio must NOT overwrite the row.
      await upsertArtistGenres(sql, [
        { discogs_artist_id: DISCOGS_UPSERT_A, genres: ['Pop'], styles: ['Synth-pop'], artist_bio: 'A different bio.' },
      ]);
      const [persisted] = await sql.unsafe(
        `SELECT genres, styles, artist_bio FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = $1`,
        [DISCOGS_UPSERT_A]
      );
      expect(persisted.genres).toEqual(['Jazz']);
      expect(persisted.styles).toEqual(['Big Band']);
      expect(persisted.artist_bio).toBe('A big band jazz outfit.');
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

  describe('GET /concerts artist_bio projection (BS#1734)', () => {
    it('emits the joined artist_bio for a resolved + enriched headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const enriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_ENRICHED);
      expect(enriched).toBeDefined();
      expect(enriched.artist_bio).toBe(ARTIST_BIO);
    });

    it('emits null artist_bio for a resolved-but-unenriched headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const unenriched = res.body.concerts.find((c) => c.headlining_artist_raw === ARTIST_LIBRARY_UNENRICHED);
      expect(unenriched).toBeDefined();
      expect(unenriched.artist_bio).toBeNull();
    });

    it('emits null artist_bio for an unresolved headliner', async () => {
      const res = await auth.get(`/concerts?from=${IN_10}&to=${IN_10}`).expect(200);
      const unresolved = res.body.concerts.find((c) => c.headlining_artist_raw === 'Some Unresolved Billing & Another');
      expect(unresolved).toBeDefined();
      expect(unresolved.artist_bio).toBeNull();
    });
  });

  describe('bio backfill (mirror of query.ts + writer.ts, BS#1734)', () => {
    it('selects genres-only null-bio rows, resolves a deterministic non-removed name, excludes populated bios', async () => {
      const rows = await loadBioBackfillCandidates(sql, [DISCOGS_ENRICHED, DISCOGS_BIO_NULL_LIB, DISCOGS_BIO_NULL_EXT]);
      const byId = new Map(rows.map((r) => [Number(r.discogs_artist_id), r.artist_name]));

      // A row that already carries a bio is not a candidate.
      expect(byId.has(DISCOGS_ENRICHED)).toBe(false);
      // Library headliner → canonical artists.artist_name.
      expect(byId.get(DISCOGS_BIO_NULL_LIB)).toBe(ARTIST_BIO_NULL_LIB);
      // Discogs-only headliner → freshest ACTIVE billing: not the later-dated but
      // REMOVED concert (proves removed_at exclusion), not the older active one
      // (proves the starts_on DESC tie-break).
      expect(byId.get(DISCOGS_BIO_NULL_EXT)).toBe(BIO_EXT_ACTIVE_RAW);
    });

    it('BS#1746: two artists rows sharing one discogs_artist_id yield exactly one candidate', async () => {
      const rows = await loadBioBackfillCandidates(sql, [DISCOGS_BIO_NULL_DUPE]);
      expect(rows).toHaveLength(1);
      // Deterministic tiebreak: lower artists.id wins, not an arbitrary row.
      expect(Number(rows[0].discogs_artist_id)).toBe(DISCOGS_BIO_NULL_DUPE);
      expect(rows[0].artist_name).toBe(ARTIST_BIO_NULL_DUPE_A);
    });

    it('fills a null bio, never overwrites a populated one, and a re-run over the filled row updates 0', async () => {
      // Fill the dedicated null-bio row AND attempt to clobber the already-populated one.
      const first = await applyBioBackfill(sql, [
        { discogs_artist_id: DISCOGS_BIO_FILL, genres: [], styles: [], artist_bio: 'A freshly resolved bio.' },
        { discogs_artist_id: DISCOGS_ENRICHED, genres: [], styles: [], artist_bio: 'MUST NOT overwrite.' },
      ]);
      const firstIds = first.map((r) => Number(r.discogs_artist_id));
      // Only the NULL row is updated; the setWhere blocks the populated one.
      expect(firstIds).toContain(DISCOGS_BIO_FILL);
      expect(firstIds).not.toContain(DISCOGS_ENRICHED);

      const [filled] = await sql.unsafe(
        `SELECT artist_bio FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = $1`,
        [DISCOGS_BIO_FILL]
      );
      expect(filled.artist_bio).toBe('A freshly resolved bio.');
      const [untouched] = await sql.unsafe(
        `SELECT artist_bio FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = $1`,
        [DISCOGS_ENRICHED]
      );
      expect(untouched.artist_bio).toBe(ARTIST_BIO);

      // Re-run over the now-filled row → 0 updates (setWhere excludes non-null),
      // and the stored bio is unchanged.
      const second = await applyBioBackfill(sql, [
        { discogs_artist_id: DISCOGS_BIO_FILL, genres: [], styles: [], artist_bio: 'A different bio (v2).' },
      ]);
      expect(second).toHaveLength(0);
      const [afterRerun] = await sql.unsafe(
        `SELECT artist_bio FROM "${SCHEMA}".artist_metadata WHERE discogs_artist_id = $1`,
        [DISCOGS_BIO_FILL]
      );
      expect(afterRerun.artist_bio).toBe('A freshly resolved bio.');
    });
  });
});
