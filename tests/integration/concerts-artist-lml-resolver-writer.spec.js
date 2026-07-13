/**
 * Integration tests for the concerts-artist-lml-resolver writer contract
 * (BS#1614) against a REAL Postgres (migration 0116 columns + the widened
 * curated partial index).
 *
 * Validates the SQL the cron job issues via
 * `jobs/concerts-artist-lml-resolver/targets.ts`:
 *   - candidate predicate: double-NULL id gate, tombstone + upcoming window,
 *     attempt-at marker TTL arms (NULL always eligible; stamped rows re-ask
 *     only past the TTL);
 *   - applyResolved: Discogs id + provenance + marker in one UPDATE, with
 *     the FK loop-close ONLY on a singleton `artists.discogs_artist_id`
 *     match — the FK-TIE case (two artists sharing the id) must land the
 *     Discogs id while the FK stays NULL, because a broken singleton check
 *     would FK the concert to an arbitrary duplicate (the mislabel class
 *     the strict resolver's LIMIT 2 collapse exists to prevent);
 *   - the double-NULL guard: a row another arm resolved mid-run is untouched;
 *   - applyNoMatch: marker-only stamp that arms the TTL retry window;
 *   - idempotency: a drained set yields zero candidates on re-run;
 *   - curated widening: a Discogs-id-only row surfaces in
 *     GET /concerts?curated=true, and the widened predicate still matches
 *     the recreated `concerts_curated_starts_on_idx` partial index.
 *
 * Pure SQL — does NOT import the TS job (the integration runner is
 * babel-jest with no TS support). Mirrors the sibling
 * `catalog-popularity-freetext-resolve-upsert.spec.js` in shape. When the
 * writer in `jobs/concerts-artist-lml-resolver/targets.ts` is hand-edited,
 * the SQL here must follow.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1614:';
const VENUE_SLUG = 'bs1614-probe-room';
const ARTIST_PREFIX = 'BS#1614 Probe';
const MATCH_SOURCE = 'lml_artist_resolve';
const TTL_DAYS = 30;

// Discogs ids used by the FK-loop-close cases. Arbitrary but stable, chosen
// high to stay clear of any seeded fixture data.
const DISCOGS_SINGLETON = 91614001;
const DISCOGS_TIE = 91614002;
const DISCOGS_UNKNOWN = 91614003;

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

/** Mirror of `loadHeadlinerCandidates` in targets.ts. */
async function loadCandidates(sql, ttlDays = TTL_DAYS) {
  return sql.unsafe(
    `SELECT "id", "headlining_artist_raw" AS raw_name
     FROM "${SCHEMA}".concerts
     WHERE "headlining_artist_id" IS NULL
       AND "headlining_discogs_artist_id" IS NULL
       AND "headlining_artist_raw" IS NOT NULL
       AND "removed_at" IS NULL
       AND "starts_on" >= CURRENT_DATE
       AND ("artist_resolve_attempted_at" IS NULL
         OR "artist_resolve_attempted_at" < now() - (interval '1 day' * $1))
       AND "source_id" LIKE $2
     ORDER BY "id" ASC`,
    [ttlDays, `${SOURCE_ID_PREFIX}%`]
  );
}

/** Mirror of `lookupSingletonLibraryArtistId` + `applyResolved` in targets.ts. */
async function applyResolved(sql, rowIds, discogsArtistId) {
  const artists = await sql.unsafe(`SELECT "id" FROM "${SCHEMA}".artists WHERE "discogs_artist_id" = $1 LIMIT 2`, [
    discogsArtistId,
  ]);
  const fkArtistId = artists.length === 1 ? artists[0].id : null;
  const setFk = fkArtistId === null ? '' : `, "headlining_artist_id" = ${Number(fkArtistId)}`;
  const updated = await sql.unsafe(
    `UPDATE "${SCHEMA}".concerts
     SET "headlining_discogs_artist_id" = $1,
         "headlining_discogs_artist_id_source" = $2,
         "artist_resolve_attempted_at" = now()${setFk}
     WHERE "id" = ANY($3)
       AND "headlining_artist_id" IS NULL
       AND "headlining_discogs_artist_id" IS NULL
     RETURNING "id"`,
    [discogsArtistId, MATCH_SOURCE, rowIds]
  );
  return { updated: updated.length, fk_loop_closed: fkArtistId === null ? 0 : updated.length };
}

/** Mirror of `applyNoMatch` in targets.ts. */
async function applyNoMatch(sql, rowIds) {
  const updated = await sql.unsafe(
    `UPDATE "${SCHEMA}".concerts
     SET "artist_resolve_attempted_at" = now()
     WHERE "id" = ANY($1)
       AND "headlining_artist_id" IS NULL
       AND "headlining_discogs_artist_id" IS NULL
     RETURNING "id"`,
    [rowIds]
  );
  return { updated: updated.length };
}

async function readRow(sql, key) {
  const rows = await sql.unsafe(
    `SELECT "id", "headlining_artist_id", "headlining_discogs_artist_id",
            "headlining_discogs_artist_id_source", "artist_resolve_attempted_at"
     FROM "${SCHEMA}".concerts WHERE "source_id" = $1`,
    [SOURCE_ID_PREFIX + key]
  );
  return rows[0];
}

describe('concerts-artist-lml-resolver writer contract (BS#1614)', () => {
  let auth;
  let sql;
  let venueId;
  let libraryArtistId;

  const seedConcert = async (key, overrides = {}) => {
    const row = {
      starts_on: isoDate(10),
      headlining_artist_raw: `${ARTIST_PREFIX} ${key}`,
      headlining_artist_id: null,
      headlining_discogs_artist_id: null,
      headlining_discogs_artist_id_source: null,
      artist_resolve_attempted_at: null,
      removed_at: null,
      ...overrides,
    };
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, headlining_artist_raw,
          headlining_artist_id, headlining_discogs_artist_id,
          headlining_discogs_artist_id_source, artist_resolve_attempted_at,
          removed_at, status, supporting_artists_raw, raw_data, scraped_at)
       VALUES ('triangle_shows', $1, $2, $3, $4, $5, $6, $7, $8, $9,
               'on_sale', '{}', '{}'::jsonb, now())
       RETURNING id`,
      [
        SOURCE_ID_PREFIX + key,
        venueId,
        row.starts_on,
        row.headlining_artist_raw,
        row.headlining_artist_id,
        row.headlining_discogs_artist_id,
        row.headlining_discogs_artist_id_source,
        row.artist_resolve_attempted_at,
        row.removed_at,
      ]
    );
    return inserted.id;
  };

  const seedArtist = async (name, discogsArtistId) => {
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters, discogs_artist_id)
       VALUES ($1, $1, 'ZZ', $2) RETURNING id`,
      [name, discogsArtistId]
    );
    return artist.id;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".venues WHERE slug = $1`, [VENUE_SLUG]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name LIKE $1`, [`${ARTIST_PREFIX}%`]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    await cleanup(); // idempotent across re-runs (shared schema, --runInBand)

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1614 Probe Room', 'Durham', 'NC', '123 Foster St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;

    libraryArtistId = await seedArtist(`${ARTIST_PREFIX} Singleton`, DISCOGS_SINGLETON);
    await seedArtist(`${ARTIST_PREFIX} Tie A`, DISCOGS_TIE);
    await seedArtist(`${ARTIST_PREFIX} Tie B`, DISCOGS_TIE);
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  describe('candidate predicate', () => {
    let freshId;
    let ttlExpiredId;

    beforeAll(async () => {
      freshId = await seedConcert('cand-fresh');
      await seedConcert('cand-fk-resolved', { headlining_artist_id: libraryArtistId });
      await seedConcert('cand-discogs-resolved', {
        headlining_discogs_artist_id: DISCOGS_UNKNOWN,
        headlining_discogs_artist_id_source: MATCH_SOURCE,
      });
      await seedConcert('cand-tombstoned', { removed_at: new Date() });
      await seedConcert('cand-past', { starts_on: isoDate(-5) });
      await seedConcert('cand-inside-ttl', { artist_resolve_attempted_at: new Date() });
      ttlExpiredId = await seedConcert('cand-ttl-expired', {
        artist_resolve_attempted_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      });
    });

    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}cand-%`]);
    });

    it('selects never-attempted and TTL-expired rows; excludes resolved / tombstoned / past / inside-TTL', async () => {
      const candidates = await loadCandidates(sql);
      const ids = candidates.map((c) => Number(c.id));
      expect(ids).toEqual([Number(freshId), Number(ttlExpiredId)]);
    });
  });

  describe('applyResolved', () => {
    afterEach(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}res-%`]);
    });

    it('singleton library artist: Discogs id + provenance + marker + FK loop-close, fanned to all rows', async () => {
      const idA = await seedConcert('res-single-a', { headlining_artist_raw: `${ARTIST_PREFIX} Singleton` });
      const idB = await seedConcert('res-single-b', { headlining_artist_raw: `${ARTIST_PREFIX} Singleton` });

      const result = await applyResolved(sql, [idA, idB], DISCOGS_SINGLETON);
      expect(result).toEqual({ updated: 2, fk_loop_closed: 2 });

      for (const key of ['res-single-a', 'res-single-b']) {
        const row = await readRow(sql, key);
        expect(Number(row.headlining_discogs_artist_id)).toBe(DISCOGS_SINGLETON);
        expect(row.headlining_discogs_artist_id_source).toBe(MATCH_SOURCE);
        expect(row.artist_resolve_attempted_at).not.toBeNull();
        expect(Number(row.headlining_artist_id)).toBe(Number(libraryArtistId));
      }
    });

    it('FK TIE: two artists share the discogs_artist_id → Discogs id lands, FK stays NULL', async () => {
      // A broken singleton check would FK this concert to an arbitrary one of
      // the two `artists` rows — a silent mislabel. The column has NO unique
      // constraint, so this duplicate state is legal and occurs in the wild.
      const id = await seedConcert('res-tie');

      const result = await applyResolved(sql, [id], DISCOGS_TIE);
      expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });

      const row = await readRow(sql, 'res-tie');
      expect(Number(row.headlining_discogs_artist_id)).toBe(DISCOGS_TIE);
      expect(row.headlining_artist_id).toBeNull();
      expect(row.artist_resolve_attempted_at).not.toBeNull();
    });

    it('no library artist: Discogs id lands, FK stays NULL', async () => {
      const id = await seedConcert('res-unknown');

      const result = await applyResolved(sql, [id], DISCOGS_UNKNOWN);
      expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });

      const row = await readRow(sql, 'res-unknown');
      expect(Number(row.headlining_discogs_artist_id)).toBe(DISCOGS_UNKNOWN);
      expect(row.headlining_artist_id).toBeNull();
    });

    it('double-NULL guard: a row the SQL arm resolved mid-run is untouched', async () => {
      const id = await seedConcert('res-raced', { headlining_artist_id: libraryArtistId });

      const result = await applyResolved(sql, [id], DISCOGS_UNKNOWN);
      expect(result).toEqual({ updated: 0, fk_loop_closed: 0 });

      const row = await readRow(sql, 'res-raced');
      expect(row.headlining_discogs_artist_id).toBeNull();
      expect(row.headlining_discogs_artist_id_source).toBeNull();
      expect(row.artist_resolve_attempted_at).toBeNull();
    });
  });

  describe('applyNoMatch + TTL retry window', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}nm-%`]);
    });

    it('stamps only the marker, removing the row from candidates until the TTL expires', async () => {
      const id = await seedConcert('nm-row');

      const result = await applyNoMatch(sql, [id]);
      expect(result).toEqual({ updated: 1 });

      const row = await readRow(sql, 'nm-row');
      expect(row.headlining_discogs_artist_id).toBeNull();
      expect(row.headlining_discogs_artist_id_source).toBeNull();
      expect(row.artist_resolve_attempted_at).not.toBeNull();

      // Inside the TTL: not a candidate.
      let ids = (await loadCandidates(sql)).map((c) => Number(c.id));
      expect(ids).not.toContain(Number(id));

      // Back-date the marker past the TTL: eligible again (a later Discogs
      // addition can match a previous not_found).
      await sql.unsafe(
        `UPDATE "${SCHEMA}".concerts SET "artist_resolve_attempted_at" = now() - interval '40 days' WHERE "id" = $1`,
        [id]
      );
      ids = (await loadCandidates(sql)).map((c) => Number(c.id));
      expect(ids).toContain(Number(id));
    });
  });

  describe('idempotent re-run', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}rerun-%`]);
    });

    it('a drained candidate set selects nothing on the second pass', async () => {
      const idResolved = await seedConcert('rerun-resolved');
      const idNoMatch = await seedConcert('rerun-nomatch');

      await applyResolved(sql, [idResolved], DISCOGS_UNKNOWN);
      await applyNoMatch(sql, [idNoMatch]);

      const candidates = await loadCandidates(sql);
      expect(candidates).toEqual([]);
    });
  });

  describe('curated widening (GET /concerts?curated=true)', () => {
    let discogsOnlyId;

    beforeAll(async () => {
      discogsOnlyId = await seedConcert('cur-discogs-only', {
        headlining_discogs_artist_id: DISCOGS_UNKNOWN,
        headlining_discogs_artist_id_source: MATCH_SOURCE,
        artist_resolve_attempted_at: new Date(),
      });
      await seedConcert('cur-unresolved');
    });

    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}cur-%`]);
    });

    it('a Discogs-id-only row is curated; an unresolved row is not', async () => {
      const response = await auth.get('/concerts?curated=true&limit=100');
      expect(response.status).toBe(200);

      const ids = response.body.concerts.map((c) => Number(c.id));
      expect(ids).toContain(Number(discogsOnlyId));

      const unresolved = await readRow(sql, 'cur-unresolved');
      expect(ids).not.toContain(Number(unresolved.id));
    });

    it('the widened curated predicate still matches the partial index', async () => {
      // Regression pin for the index/read-path lockstep rule: if buildWhere's
      // OR predicate drifts from the concerts_curated_starts_on_idx partial
      // predicate, the planner can no longer use the index. The dataset is
      // tiny so the planner would normally seq-scan; SET LOCAL enable_seqscan
      // off forces it to prove the index is USABLE, which is exactly the
      // predicate-match property this pins.
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL enable_seqscan = off`);
        return tx.unsafe(
          `EXPLAIN (FORMAT JSON)
           SELECT "id" FROM "${SCHEMA}".concerts
           WHERE ("headlining_artist_id" IS NOT NULL OR "headlining_discogs_artist_id" IS NOT NULL)
             AND "removed_at" IS NULL
             AND "starts_on" >= CURRENT_DATE
           ORDER BY "starts_on", "id"`
        );
      });
      expect(JSON.stringify(rows[0]['QUERY PLAN'])).toContain('concerts_curated_starts_on_idx');
    });
  });
});
