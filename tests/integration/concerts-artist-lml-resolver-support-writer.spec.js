/**
 * Integration tests for the concerts-artist-lml-resolver `supportTarget`
 * writer contract (BS#1763, parent #1618, On Tour epic #1588) against a
 * REAL Postgres (migration 0128's `concert_performers` columns).
 *
 * Sibling of `concerts-artist-lml-resolver-writer.spec.js` (the headliner
 * target) — same writer contract, one level down on `concert_performers`:
 *   - candidate predicate: double-NULL id gate, tombstone (junction row AND
 *     parent concert) + upcoming window, attempt-at marker TTL arms, and
 *     the RAW-NAME-ONLY tribute guard — deliberately does NOT exclude on
 *     the parent concert's `title` (a support at a tribute-titled show is
 *     a real opener, not a mislabeled honoree; see BS#1760's locked
 *     decision, carried over to this LML lane);
 *   - applyResolved: Discogs id + provenance + marker in one UPDATE, with
 *     the FK loop-close ONLY on a singleton `artists.discogs_artist_id`
 *     match (the same `lookupSingletonLibraryArtistId` check the headliner
 *     target uses);
 *   - the double-NULL guard: a row concerts-artist-resolver's pure-SQL
 *     support arm resolved mid-run is untouched;
 *   - applyNoMatch: marker-only stamp that arms the TTL retry window;
 *   - idempotency: a drained set yields zero candidates on re-run;
 *   - has_resolved_support: a discogs-only support (no library artist_id)
 *     flips the shared windowed recompute to true the SAME cycle it
 *     resolves in — no one-cycle lag.
 *
 * Pure SQL — does NOT import the TS job (the integration runner is
 * babel-jest with no TS support). Mirrors both
 * `concerts-artist-lml-resolver-writer.spec.js` (this target's sibling) and
 * `concerts-artist-resolver-support.spec.js` (the recompute mirror) in
 * shape. When `jobs/concerts-artist-lml-resolver/targets.ts`'s
 * `supportTarget` or `shared/database/src/concerts-recompute.ts` are
 * hand-edited, the SQL here must follow.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1763:';
const VENUE_SLUG = 'bs1763-probe-room';
const ARTIST_PREFIX = 'BS#1763 Probe';
const MATCH_SOURCE = 'lml_artist_resolve';
const TTL_DAYS = 30;

// Discogs ids used by the FK-loop-close cases. Arbitrary but stable, chosen
// high to stay clear of any seeded fixture data and of the sibling
// headliner spec's own range.
const DISCOGS_SINGLETON = 91763001;
const DISCOGS_TIE = 91763002;
const DISCOGS_UNKNOWN = 91763003;

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

/** Mirror of `loadSupportCandidates` in targets.ts, scoped to this file's
 *  concerts via the joined concert's source_id (concert_performers itself
 *  carries no source_id). */
async function loadCandidates(sql, ttlDays = TTL_DAYS) {
  return sql.unsafe(
    `SELECT cp."id", cp."raw_name" AS raw_name
     FROM "${SCHEMA}".concert_performers cp
     JOIN "${SCHEMA}".concerts c ON c."id" = cp."concert_id"
     WHERE cp."artist_id" IS NULL
       AND cp."discogs_artist_id" IS NULL
       AND cp."removed_at" IS NULL
       AND cp."role" = 'support'
       AND cp."raw_name" !~* '\\mtribute'
       AND c."removed_at" IS NULL
       AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
       AND (cp."artist_resolve_attempted_at" IS NULL
         OR cp."artist_resolve_attempted_at" < now() - (interval '1 day' * $1))
       AND c."source_id" LIKE $2
     ORDER BY cp."id" ASC`,
    [ttlDays, `${SOURCE_ID_PREFIX}%`]
  );
}

/** Mirror of `lookupSingletonLibraryArtistId` + `supportTarget.applyResolved`. */
async function applyResolved(sql, rowIds, discogsArtistId) {
  const artists = await sql.unsafe(`SELECT "id" FROM "${SCHEMA}".artists WHERE "discogs_artist_id" = $1 LIMIT 2`, [
    discogsArtistId,
  ]);
  const fkArtistId = artists.length === 1 ? artists[0].id : null;
  const setFk = fkArtistId === null ? '' : `, "artist_id" = ${Number(fkArtistId)}`;
  const updated = await sql.unsafe(
    `UPDATE "${SCHEMA}".concert_performers
     SET "discogs_artist_id" = $1,
         "discogs_artist_id_source" = $2,
         "artist_resolve_attempted_at" = now()${setFk}
     WHERE "id" = ANY($3)
       AND "artist_id" IS NULL
       AND "discogs_artist_id" IS NULL
     RETURNING "id"`,
    [discogsArtistId, MATCH_SOURCE, rowIds]
  );
  return { updated: updated.length, fk_loop_closed: fkArtistId === null ? 0 : updated.length };
}

/** Mirror of `supportTarget.applyNoMatch`. */
async function applyNoMatch(sql, rowIds) {
  const updated = await sql.unsafe(
    `UPDATE "${SCHEMA}".concert_performers
     SET "artist_resolve_attempted_at" = now()
     WHERE "id" = ANY($1)
       AND "artist_id" IS NULL
       AND "discogs_artist_id" IS NULL
     RETURNING "id"`,
    [rowIds]
  );
  return { updated: updated.length };
}

/** Mirror of `recomputeHasResolvedSupport` (shared/database/src/concerts-
 *  recompute.ts) — global (unscoped) exactly like the production function
 *  and its twin in concerts-artist-resolver-support.spec.js. Tests here
 *  only assert on THIS file's own rows (via readConcert), never on the
 *  aggregate returned count, so concurrent activity from other suites
 *  against unrelated rows can't make this file flaky. */
async function recomputeHasResolvedSupport(sql) {
  const rows = await sql.unsafe(`
    WITH computed AS (
      SELECT
        c."id",
        EXISTS (
          SELECT 1 FROM "${SCHEMA}".concert_performers cp
          WHERE cp."concert_id" = c."id"
            AND cp."role" = 'support'
            AND cp."removed_at" IS NULL
            AND (cp."artist_id" IS NOT NULL OR cp."discogs_artist_id" IS NOT NULL)
        ) AS resolved
      FROM "${SCHEMA}".concerts c
      WHERE c."removed_at" IS NULL
        AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
    )
    UPDATE "${SCHEMA}".concerts c
    SET "has_resolved_support" = computed.resolved,
        "last_modified" = now()
    FROM computed
    WHERE c."id" = computed."id"
      AND c."has_resolved_support" IS DISTINCT FROM computed.resolved
    RETURNING computed.resolved AS resolved
  `);
  return rows.length;
}

async function readPerformerRow(sql, key) {
  const rows = await sql.unsafe(
    `SELECT cp."id", cp."artist_id", cp."discogs_artist_id",
            cp."discogs_artist_id_source", cp."artist_resolve_attempted_at"
     FROM "${SCHEMA}".concert_performers cp
     JOIN "${SCHEMA}".concerts c ON c."id" = cp."concert_id"
     WHERE c."source_id" = $1 AND cp."role" = 'support'`,
    [SOURCE_ID_PREFIX + key]
  );
  return rows[0];
}

async function readConcert(sql, key) {
  const rows = await sql.unsafe(
    `SELECT "id", "has_resolved_support" FROM "${SCHEMA}".concerts WHERE "source_id" = $1`,
    [SOURCE_ID_PREFIX + key]
  );
  return rows[0];
}

describe('concerts-artist-lml-resolver supportTarget writer contract (BS#1763)', () => {
  let sql;
  let venueId;
  let libraryArtistId;

  /** Seeds a concert plus ONE `role='support'` concert_performers row for
   *  it, in one call — the shape almost every test below needs. */
  const seedConcertWithSupport = async (key, { concertOverrides = {}, performerOverrides = {} } = {}) => {
    const concert = {
      starts_on: isoDate(10),
      title: null,
      headlining_artist_raw: `${ARTIST_PREFIX} ${key} Headliner`,
      removed_at: null,
      ...concertOverrides,
    };
    const [insertedConcert] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, title, headlining_artist_raw,
          removed_at, status, supporting_artists_raw, raw_data, scraped_at)
       VALUES ('triangle_shows', $1, $2, $3, $4, $5, $6, 'on_sale', '{}', '{}'::jsonb, now())
       RETURNING id`,
      [
        SOURCE_ID_PREFIX + key,
        venueId,
        concert.starts_on,
        concert.title,
        concert.headlining_artist_raw,
        concert.removed_at,
      ]
    );
    const concertId = insertedConcert.id;

    const performer = {
      raw_name: `${ARTIST_PREFIX} ${key} Support`,
      artist_id: null,
      discogs_artist_id: null,
      discogs_artist_id_source: null,
      artist_resolve_attempted_at: null,
      removed_at: null,
      ...performerOverrides,
    };
    const [insertedPerformer] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concert_performers
         (concert_id, raw_name, role, artist_id, discogs_artist_id,
          discogs_artist_id_source, artist_resolve_attempted_at, removed_at)
       VALUES ($1, $2, 'support', $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        concertId,
        performer.raw_name,
        performer.artist_id,
        performer.discogs_artist_id,
        performer.discogs_artist_id_source,
        performer.artist_resolve_attempted_at,
        performer.removed_at,
      ]
    );
    return { concertId, performerId: insertedPerformer.id, rawName: performer.raw_name };
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
    sql = makeSql();
    await cleanup(); // idempotent across re-runs (shared schema, --runInBand)

    const [venue] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".venues (slug, name, city, state, address)
       VALUES ($1, 'BS1763 Probe Room', 'Durham', 'NC', '123 Foster St')
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
    let tributariesId;
    let tributeTitleSupportId;

    beforeAll(async () => {
      ({ performerId: freshId } = await seedConcertWithSupport('cand-fresh'));
      await seedConcertWithSupport('cand-fk-resolved', { performerOverrides: { artist_id: libraryArtistId } });
      await seedConcertWithSupport('cand-discogs-resolved', {
        performerOverrides: { discogs_artist_id: DISCOGS_UNKNOWN, discogs_artist_id_source: MATCH_SOURCE },
      });
      await seedConcertWithSupport('cand-junction-tombstoned', { performerOverrides: { removed_at: new Date() } });
      await seedConcertWithSupport('cand-concert-tombstoned', { concertOverrides: { removed_at: new Date() } });
      await seedConcertWithSupport('cand-past', { concertOverrides: { starts_on: isoDate(-5) } });
      await seedConcertWithSupport('cand-inside-ttl', {
        performerOverrides: { artist_resolve_attempted_at: new Date() },
      });
      ({ performerId: ttlExpiredId } = await seedConcertWithSupport('cand-ttl-expired', {
        performerOverrides: { artist_resolve_attempted_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
      }));
      // Raw-name tribute guard, against real PG regex semantics.
      await seedConcertWithSupport('cand-tribute-raw', { performerOverrides: { raw_name: 'Tribute Openers' } });
      ({ performerId: tributariesId } = await seedConcertWithSupport('cand-tributaries', {
        performerOverrides: { raw_name: `${ARTIST_PREFIX} Tributaries` },
      }));
      // The divergence this target is built around: a support billed at a
      // TRIBUTE-TITLED show is a real opener, not a mislabeled honoree — the
      // concert's own `title` must NOT gate this candidate (unlike the
      // headliner target's loadHeadlinerCandidates, which excludes on title).
      // raw_name is explicitly clean (NOT derived from the `cand-tribute-title`
      // key, which would itself trip the raw-name guard as a false positive).
      ({ performerId: tributeTitleSupportId } = await seedConcertWithSupport('cand-tribute-title', {
        concertOverrides: { title: 'AN ELECTRIFYING TRIBUTE TO BILLY JOEL' },
        performerOverrides: { raw_name: `${ARTIST_PREFIX} Real Opener` },
      }));
    });

    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}cand-%`]);
    });

    it('selects never-attempted and TTL-expired rows; excludes resolved / tombstoned (either side) / past / inside-TTL / raw-name-tribute', async () => {
      const candidates = await loadCandidates(sql);
      const ids = candidates.map((c) => Number(c.id));
      expect(ids.sort((a, b) => a - b)).toEqual(
        [freshId, ttlExpiredId, tributariesId, tributeTitleSupportId].map(Number).sort((a, b) => a - b)
      );
    });

    it('a support at a tribute-TITLED show is still a candidate — the guard is raw-name-only', async () => {
      const candidates = await loadCandidates(sql);
      const ids = candidates.map((c) => Number(c.id));
      expect(ids).toContain(Number(tributeTitleSupportId));
    });
  });

  describe('applyResolved', () => {
    afterEach(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}res-%`]);
    });

    it('singleton library artist: Discogs id + provenance + marker + FK loop-close, fanned to all rows', async () => {
      const a = await seedConcertWithSupport('res-single-a', {
        performerOverrides: { raw_name: `${ARTIST_PREFIX} Singleton` },
      });
      const b = await seedConcertWithSupport('res-single-b', {
        performerOverrides: { raw_name: `${ARTIST_PREFIX} Singleton` },
      });

      const result = await applyResolved(sql, [a.performerId, b.performerId], DISCOGS_SINGLETON);
      expect(result).toEqual({ updated: 2, fk_loop_closed: 2 });

      for (const key of ['res-single-a', 'res-single-b']) {
        const row = await readPerformerRow(sql, key);
        expect(Number(row.discogs_artist_id)).toBe(DISCOGS_SINGLETON);
        expect(row.discogs_artist_id_source).toBe(MATCH_SOURCE);
        expect(row.artist_resolve_attempted_at).not.toBeNull();
        expect(Number(row.artist_id)).toBe(Number(libraryArtistId));
      }
    });

    it('FK TIE: two artists share the discogs_artist_id → Discogs id lands, FK stays NULL', async () => {
      const { performerId } = await seedConcertWithSupport('res-tie');

      const result = await applyResolved(sql, [performerId], DISCOGS_TIE);
      expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });

      const row = await readPerformerRow(sql, 'res-tie');
      expect(Number(row.discogs_artist_id)).toBe(DISCOGS_TIE);
      expect(row.artist_id).toBeNull();
      expect(row.artist_resolve_attempted_at).not.toBeNull();
    });

    it('no library artist: Discogs id lands, FK stays NULL', async () => {
      const { performerId } = await seedConcertWithSupport('res-unknown');

      const result = await applyResolved(sql, [performerId], DISCOGS_UNKNOWN);
      expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });

      const row = await readPerformerRow(sql, 'res-unknown');
      expect(Number(row.discogs_artist_id)).toBe(DISCOGS_UNKNOWN);
      expect(row.artist_id).toBeNull();
    });

    it('double-NULL guard: a row the pure-SQL support arm resolved mid-run is untouched', async () => {
      const { performerId } = await seedConcertWithSupport('res-raced', {
        performerOverrides: { artist_id: libraryArtistId },
      });

      const result = await applyResolved(sql, [performerId], DISCOGS_UNKNOWN);
      expect(result).toEqual({ updated: 0, fk_loop_closed: 0 });

      const row = await readPerformerRow(sql, 'res-raced');
      expect(row.discogs_artist_id).toBeNull();
      expect(row.discogs_artist_id_source).toBeNull();
      expect(row.artist_resolve_attempted_at).toBeNull();
    });
  });

  describe('applyNoMatch + TTL retry window', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}nm-%`]);
    });

    it('stamps only the marker, removing the row from candidates until the TTL expires', async () => {
      const { performerId } = await seedConcertWithSupport('nm-row');

      const result = await applyNoMatch(sql, [performerId]);
      expect(result).toEqual({ updated: 1 });

      const row = await readPerformerRow(sql, 'nm-row');
      expect(row.discogs_artist_id).toBeNull();
      expect(row.discogs_artist_id_source).toBeNull();
      expect(row.artist_resolve_attempted_at).not.toBeNull();

      let ids = (await loadCandidates(sql)).map((c) => Number(c.id));
      expect(ids).not.toContain(Number(performerId));

      await sql.unsafe(
        `UPDATE "${SCHEMA}".concert_performers SET "artist_resolve_attempted_at" = now() - interval '40 days' WHERE "id" = $1`,
        [performerId]
      );
      ids = (await loadCandidates(sql)).map((c) => Number(c.id));
      expect(ids).toContain(Number(performerId));
    });
  });

  describe('idempotent re-run', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}rerun-%`]);
    });

    it('a drained candidate set selects nothing on the second pass', async () => {
      const resolved = await seedConcertWithSupport('rerun-resolved');
      const noMatch = await seedConcertWithSupport('rerun-nomatch');

      await applyResolved(sql, [resolved.performerId], DISCOGS_UNKNOWN);
      await applyNoMatch(sql, [noMatch.performerId]);

      const candidates = await loadCandidates(sql);
      expect(candidates).toEqual([]);
    });
  });

  describe('has_resolved_support: no one-cycle lag for a discogs-only support', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}hrs-%`]);
    });

    it('a fresh candidate resolved via the Discogs-only lane flips has_resolved_support true in the SAME pass', async () => {
      const { concertId, performerId } = await seedConcertWithSupport('hrs-discogs-only');

      // Before resolution: false (default; no resolved support yet).
      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(sql, 'hrs-discogs-only')).has_resolved_support).toBe(false);

      // The LML target resolves it via the bare-Discogs-id lane (no library
      // FK — DISCOGS_UNKNOWN matches no seeded artist).
      const result = await applyResolved(sql, [performerId], DISCOGS_UNKNOWN);
      expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });
      const row = await readPerformerRow(sql, 'hrs-discogs-only');
      expect(row.artist_id).toBeNull();
      expect(Number(row.discogs_artist_id)).toBe(DISCOGS_UNKNOWN);

      // job.ts calls the SAME shared recompute right after runResolve
      // finishes — this is that call, and it must see this cycle's write
      // without a second cron cycle in between.
      await recomputeHasResolvedSupport(sql);
      const concert = await readConcert(sql, 'hrs-discogs-only');
      expect(concert.id).toBe(concertId);
      expect(concert.has_resolved_support).toBe(true);
    });

    it('a fresh candidate resolved via the FK loop-close (library singleton) lane ALSO flips it true', async () => {
      const { performerId } = await seedConcertWithSupport('hrs-fk-lane', {
        performerOverrides: { raw_name: `${ARTIST_PREFIX} Singleton` },
      });

      const result = await applyResolved(sql, [performerId], DISCOGS_SINGLETON);
      expect(result).toEqual({ updated: 1, fk_loop_closed: 1 });

      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(sql, 'hrs-fk-lane')).has_resolved_support).toBe(true);
    });
  });
});
