/**
 * Integration tests for the concerts-artist-resolver support sync/resolve
 * contract (BS#1760) against a REAL Postgres (migration 0128's
 * `concert_performers` table + `concerts.has_resolved_support` column).
 *
 * Validates the SQL the four-step cron run issues via jobs/concerts-
 * artist-resolver/{sync,sync-db,support,support-db,recompute}.ts:
 *
 *   - sync idempotency on (concert_id, role, raw_name): a re-sync against
 *     unchanged input inserts nothing new;
 *   - array-shrink soft-tombstone: dropping a name from
 *     supporting_artists_raw tombstones its row (removed_at set,
 *     artist_id/discogs_artist_id retained) rather than deleting it;
 *   - reappearance un-tombstone: the name coming back clears removed_at;
 *   - the support resolve arm: strict matches resolve, ambiguous names
 *     stay NULL with NO attempt-at marker (Phase-B carries none — that
 *     marker binds only the future Phase-D LML arm);
 *   - the tribute guard is RAW-NAME-ONLY: a support act billed at a
 *     tribute-titled show still resolves; a support act whose OWN raw
 *     name carries "tribute" is excluded from candidacy;
 *   - `has_resolved_support` transitions true → false → true across
 *     resolve, tombstone, and un-tombstone (the drift cases), via the
 *     dual-lane predicate (artist_id OR discogs_artist_id);
 *   - end-to-end: sync → resolve → recompute produces the right final
 *     state from a single supporting_artists_raw array.
 *
 * Pure SQL — does NOT import the TS job (the integration runner is
 * babel-jest with no TS support). Mirrors the sibling
 * `concerts-artist-lml-resolver-writer.spec.js` in shape: each helper
 * below is a hand-mirror of the corresponding production function. When
 * sync.ts / sync-db.ts / support.ts / support-db.ts / recompute.ts are
 * hand-edited, the SQL/logic here must follow.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker
 * tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SOURCE_ID_PREFIX = 'bs1760:';
const VENUE_SLUG = 'bs1760-probe-room';
const ARTIST_PREFIX = 'BS#1760 Probe';

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

// ---------------------------------------------------------------------
// Mirrors of jobs/concerts-artist-resolver/sync.ts's pure diff.
// ---------------------------------------------------------------------

/** Mirror of `diffConcertPerformers` in sync.ts. */
function diffConcertPerformers(supportingArtistsRaw, existing) {
  const arraySet = new Set(supportingArtistsRaw);
  const existingNames = new Set(existing.map((row) => row.raw_name));

  const to_insert = [...new Set(supportingArtistsRaw)].filter((name) => !existingNames.has(name));

  const to_untombstone = [];
  const to_tombstone = [];
  for (const row of existing) {
    const stillBilled = arraySet.has(row.raw_name);
    const isTombstoned = row.removed_at !== null;
    if (stillBilled && isTombstoned) to_untombstone.push(row.raw_name);
    else if (!stillBilled && !isTombstoned) to_tombstone.push(row.raw_name);
  }
  return { to_insert, to_untombstone, to_tombstone };
}

// ---------------------------------------------------------------------
// Mirrors of jobs/concerts-artist-resolver/sync-db.ts.
// ---------------------------------------------------------------------

/** Mirror of `loadSyncCandidates`'s existing-rows half, scoped to one concert. */
async function loadExistingSupportRows(sql, concertId) {
  return sql.unsafe(
    `SELECT cp."raw_name" AS raw_name, cp."removed_at" AS removed_at
     FROM "${SCHEMA}".concert_performers cp
     JOIN "${SCHEMA}".concerts c ON c."id" = cp."concert_id"
     WHERE cp."role" = 'support'
       AND cp."concert_id" = $1
       AND c."removed_at" IS NULL
       AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`,
    [concertId]
  );
}

/** Mirror of `applySyncDiff` in sync-db.ts. Each bucket's VALUES list is
 *  built with one `$N` placeholder per raw name (never a `'{...}'::text[]`
 *  literal — the BS#1068-1073 text-array corruption trap) plus the
 *  shared `$1` concert id, reused across every row in that bucket's
 *  VALUES list. */
async function applySyncDiff(sql, concertId, diff) {
  return sql.begin(async (tx) => {
    let inserted = 0;
    let untombstoned = 0;
    let tombstoned = 0;

    if (diff.to_insert.length > 0) {
      const valuesSql = diff.to_insert.map((_, i) => `($1, $${i + 2}, 'support')`).join(', ');
      const rows = await tx.unsafe(
        `INSERT INTO "${SCHEMA}".concert_performers ("concert_id", "raw_name", "role")
         VALUES ${valuesSql}
         ON CONFLICT ("concert_id", "role", "raw_name") DO NOTHING
         RETURNING id`,
        [concertId, ...diff.to_insert]
      );
      inserted = rows.length;
    }

    if (diff.to_untombstone.length > 0) {
      const rows = await tx.unsafe(
        `UPDATE "${SCHEMA}".concert_performers
         SET "removed_at" = NULL
         WHERE "concert_id" = $1 AND "role" = 'support' AND "removed_at" IS NOT NULL
           AND "raw_name" = ANY($2)
         RETURNING id`,
        [concertId, diff.to_untombstone]
      );
      untombstoned = rows.length;
    }

    if (diff.to_tombstone.length > 0) {
      const rows = await tx.unsafe(
        `UPDATE "${SCHEMA}".concert_performers
         SET "removed_at" = now()
         WHERE "concert_id" = $1 AND "role" = 'support' AND "removed_at" IS NULL
           AND "raw_name" = ANY($2)
         RETURNING id`,
        [concertId, diff.to_tombstone]
      );
      tombstoned = rows.length;
    }

    return { inserted, untombstoned, tombstoned };
  });
}

/** Full sync pass over one concert: load existing → diff → apply. */
async function syncOneConcert(sql, concertId, supportingArtistsRaw) {
  const existing = await loadExistingSupportRows(sql, concertId);
  const diff = diffConcertPerformers(
    supportingArtistsRaw,
    existing.map((r) => ({ raw_name: r.raw_name, removed_at: r.removed_at }))
  );
  return applySyncDiff(sql, concertId, diff);
}

// ---------------------------------------------------------------------
// Mirrors of jobs/concerts-artist-resolver/support-db.ts.
// ---------------------------------------------------------------------

/** Mirror of `loadSupportCandidates` in support-db.ts. */
async function loadSupportCandidates(sql) {
  return sql.unsafe(
    `SELECT cp."id", cp."raw_name"
     FROM "${SCHEMA}".concert_performers cp
     JOIN "${SCHEMA}".concerts c ON c."id" = cp."concert_id"
     WHERE cp."role" = 'support'
       AND cp."artist_id" IS NULL
       AND cp."removed_at" IS NULL
       AND cp."raw_name" !~* '\\mtribute'
       AND c."removed_at" IS NULL
       AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
       AND c.source_id LIKE $1
     ORDER BY cp."id" ASC`,
    [`${SOURCE_ID_PREFIX}%`]
  );
}

/** Mirror of `writeSupportArtistId` in support-db.ts — fill-NULLs-only, no marker. */
async function writeSupportArtistId(sql, performerId, artistId) {
  const rows = await sql.unsafe(
    `UPDATE "${SCHEMA}".concert_performers
     SET "artist_id" = $1
     WHERE "id" = $2 AND "artist_id" IS NULL
     RETURNING id`,
    [artistId, performerId]
  );
  return { written: rows.length === 1 };
}

/** Mirror of the strict arm of `resolveArtistId` (query.ts) — the only
 *  arm these tests need; alias-arm behavior is already pinned by
 *  query.test.ts and is not re-derived here. */
async function resolveStrict(sql, rawName) {
  const rows = await sql.unsafe(
    `SELECT a."id" AS artist_id
     FROM "${SCHEMA}".artists a
     WHERE "${SCHEMA}".normalize_artist_name(a."artist_name") = "${SCHEMA}".normalize_artist_name($1)
     LIMIT 2`,
    [rawName]
  );
  if (rows.length === 1) return { kind: 'strict', artist_id: Number(rows[0].artist_id) };
  if (rows.length > 1) return { kind: 'ambiguous' };
  return { kind: 'unmatched' };
}

/** Runs the support resolve arm once over every current candidate. */
async function runSupportResolveOnce(sql) {
  const candidates = await loadSupportCandidates(sql);
  const outcome = { resolved: 0, ambiguous: 0, unmatched: 0 };
  for (const candidate of candidates) {
    const verdict = await resolveStrict(sql, candidate.raw_name);
    if (verdict.kind === 'strict') {
      const { written } = await writeSupportArtistId(sql, Number(candidate.id), verdict.artist_id);
      if (written) outcome.resolved += 1;
    } else if (verdict.kind === 'ambiguous') {
      outcome.ambiguous += 1;
    } else {
      outcome.unmatched += 1;
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------
// Mirror of jobs/concerts-artist-resolver/recompute.ts.
// ---------------------------------------------------------------------

/** Mirror of `recomputeHasResolvedSupport` in recompute.ts. */
async function recomputeHasResolvedSupport(sql) {
  const rows = await sql.unsafe(
    `WITH computed AS (
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
         AND c.source_id LIKE $1
     )
     UPDATE "${SCHEMA}".concerts c
     SET "has_resolved_support" = computed.resolved,
         "last_modified" = now()
     FROM computed
     WHERE c."id" = computed."id"
       AND c."has_resolved_support" IS DISTINCT FROM computed.resolved
     RETURNING computed.resolved AS resolved`,
    [`${SOURCE_ID_PREFIX}%`]
  );
  return rows.length;
}

// ---------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------

describe('concerts-artist-resolver support sync/resolve contract (BS#1760)', () => {
  let sql;
  let venueId;

  const seedConcert = async (key, overrides = {}) => {
    const row = {
      starts_on: isoDate(10),
      title: null,
      headlining_artist_raw: `${ARTIST_PREFIX} Headliner ${key}`,
      supporting_artists_raw: [],
      removed_at: null,
      ...overrides,
    };
    const [inserted] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".concerts
         (source, source_id, venue_id, starts_on, title, headlining_artist_raw,
          supporting_artists_raw, removed_at, status, raw_data, scraped_at)
       VALUES ('triangle_shows', $1, $2, $3, $4, $5, $6, $7, 'on_sale', '{}'::jsonb, now())
       RETURNING id`,
      [
        SOURCE_ID_PREFIX + key,
        venueId,
        row.starts_on,
        row.title,
        row.headlining_artist_raw,
        row.supporting_artists_raw,
        row.removed_at,
      ]
    );
    return Number(inserted.id);
  };

  const seedArtist = async (name) => {
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [name]
    );
    return Number(artist.id);
  };

  const readPerformerRows = async (concertId) =>
    sql.unsafe(
      `SELECT "id", "raw_name", "artist_id", "discogs_artist_id", "artist_resolve_attempted_at", "removed_at"
       FROM "${SCHEMA}".concert_performers
       WHERE "concert_id" = $1 AND "role" = 'support'
       ORDER BY "raw_name" ASC`,
      [concertId]
    );

  const readConcert = async (concertId) => {
    const [row] = await sql.unsafe(`SELECT "has_resolved_support" FROM "${SCHEMA}".concerts WHERE "id" = $1`, [
      concertId,
    ]);
    return row;
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
       VALUES ($1, 'BS1760 Probe Room', 'Durham', 'NC', '123 Foster St')
       RETURNING id`,
      [VENUE_SLUG]
    );
    venueId = venue.id;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  describe('sync: idempotency + array-shrink tombstone + reappearance untombstone', () => {
    let concertId;

    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id = $1`, [`${SOURCE_ID_PREFIX}sync-1`]);
    });

    it('a fresh sync inserts one row per array element', async () => {
      concertId = await seedConcert('sync-1', { supporting_artists_raw: ['Act A', 'Act B'] });

      const outcome = await syncOneConcert(sql, concertId, ['Act A', 'Act B']);
      expect(outcome).toEqual({ inserted: 2, untombstoned: 0, tombstoned: 0 });

      const rows = await readPerformerRows(concertId);
      expect(rows.map((r) => r.raw_name)).toEqual(['Act A', 'Act B']);
      expect(rows.every((r) => r.removed_at === null)).toBe(true);
    });

    it('re-syncing the SAME array is idempotent — inserts nothing new, unique index on (concert_id, role, raw_name) never trips', async () => {
      const outcome = await syncOneConcert(sql, concertId, ['Act A', 'Act B']);
      expect(outcome).toEqual({ inserted: 0, untombstoned: 0, tombstoned: 0 });

      const rows = await readPerformerRows(concertId);
      expect(rows).toHaveLength(2);
    });

    it('array-shrink soft-tombstones the dropped row (removed_at set, row retained not deleted)', async () => {
      const outcome = await syncOneConcert(sql, concertId, ['Act A']);
      expect(outcome).toEqual({ inserted: 0, untombstoned: 0, tombstoned: 1 });

      const rows = await readPerformerRows(concertId);
      expect(rows).toHaveLength(2); // still present — never hard-deleted
      const actB = rows.find((r) => r.raw_name === 'Act B');
      expect(actB.removed_at).not.toBeNull();
      const actA = rows.find((r) => r.raw_name === 'Act A');
      expect(actA.removed_at).toBeNull();
    });

    it('reappearance clears removed_at (un-tombstone)', async () => {
      const outcome = await syncOneConcert(sql, concertId, ['Act A', 'Act B']);
      expect(outcome).toEqual({ inserted: 0, untombstoned: 1, tombstoned: 0 });

      const rows = await readPerformerRows(concertId);
      expect(rows.every((r) => r.removed_at === null)).toBe(true);
    });

    it('a tombstoned row RETAINS a previously-resolved artist_id (never re-spend the future LML budget on re-bill)', async () => {
      const artistId = await seedArtist(`${ARTIST_PREFIX} Retained`);
      // Simulate a prior resolve directly, then shrink the array.
      await sql.unsafe(
        `UPDATE "${SCHEMA}".concert_performers SET "artist_id" = $1 WHERE "concert_id" = $2 AND "raw_name" = 'Act B'`,
        [artistId, concertId]
      );

      await syncOneConcert(sql, concertId, ['Act A']); // drops Act B again

      const rows = await readPerformerRows(concertId);
      const actB = rows.find((r) => r.raw_name === 'Act B');
      expect(actB.removed_at).not.toBeNull();
      expect(Number(actB.artist_id)).toBe(artistId);

      // Restore steady state for the outer describe's afterAll cleanup
      // expectations (harmless either way — cleanup deletes by concert).
      await syncOneConcert(sql, concertId, ['Act A', 'Act B']);
    });
  });

  describe('support resolve arm', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}res-%`]);
    });

    it('a strict singleton match resolves artist_id with NO attempt-at marker stamped', async () => {
      const artistId = await seedArtist(`${ARTIST_PREFIX} Strict Match`);
      const concertId = await seedConcert('res-strict', { supporting_artists_raw: [`${ARTIST_PREFIX} Strict Match`] });
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} Strict Match`]);

      const outcome = await runSupportResolveOnce(sql);
      expect(outcome.resolved).toBeGreaterThanOrEqual(1);

      const rows = await readPerformerRows(concertId);
      expect(Number(rows[0].artist_id)).toBe(artistId);
      // Phase-B carries NO marker — that binds only the future Phase-D LML arm.
      expect(rows[0].artist_resolve_attempted_at).toBeNull();
    });

    it('an ambiguous name (two artists share the normalized name) stays NULL with no marker', async () => {
      const dupName = `${ARTIST_PREFIX} Dup Name`;
      await seedArtist(dupName);
      await seedArtist(dupName);
      const concertId = await seedConcert('res-ambiguous', { supporting_artists_raw: [dupName] });
      await syncOneConcert(sql, concertId, [dupName]);

      const outcome = await runSupportResolveOnce(sql);
      expect(outcome.ambiguous).toBeGreaterThanOrEqual(1);

      const rows = await readPerformerRows(concertId);
      const row = rows.find((r) => r.raw_name === dupName);
      expect(row.artist_id).toBeNull();
      expect(row.artist_resolve_attempted_at).toBeNull();
    });

    it('idempotent re-run: an already-resolved row is never re-selected as a candidate', async () => {
      const artistId = await seedArtist(`${ARTIST_PREFIX} Rerun Match`);
      const concertId = await seedConcert('res-rerun', { supporting_artists_raw: [`${ARTIST_PREFIX} Rerun Match`] });
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} Rerun Match`]);
      await runSupportResolveOnce(sql);

      const candidatesBefore = await loadSupportCandidates(sql);
      const stillCandidate = candidatesBefore.some((c) => c.raw_name === `${ARTIST_PREFIX} Rerun Match`);
      expect(stillCandidate).toBe(false);

      const rows = await readPerformerRows(concertId);
      expect(Number(rows[0].artist_id)).toBe(artistId);
    });
  });

  describe('tribute guard is RAW-NAME-ONLY (deliberate divergence from the headliner arm)', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}trib-%`]);
    });

    it('a support act at a TRIBUTE-TITLED show is NOT excluded — it is a real opener', async () => {
      const artistId = await seedArtist(`${ARTIST_PREFIX} Real Opener`);
      const concertId = await seedConcert('trib-title', {
        title: 'AN ELECTRIFYING TRIBUTE TO BILLY JOEL',
        supporting_artists_raw: [`${ARTIST_PREFIX} Real Opener`],
      });
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} Real Opener`]);

      const candidates = await loadSupportCandidates(sql);
      expect(candidates.some((c) => c.raw_name === `${ARTIST_PREFIX} Real Opener`)).toBe(true);

      await runSupportResolveOnce(sql);
      const rows = await readPerformerRows(concertId);
      expect(Number(rows[0].artist_id)).toBe(artistId);
    });

    it('a support act whose OWN raw name carries "tribute" is excluded from candidacy', async () => {
      const concertId = await seedConcert('trib-raw', {
        title: null,
        supporting_artists_raw: [`${ARTIST_PREFIX} Tribute Band`],
      });
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} Tribute Band`]);

      const candidates = await loadSupportCandidates(sql);
      expect(candidates.some((c) => c.raw_name === `${ARTIST_PREFIX} Tribute Band`)).toBe(false);

      // Word-start match: "Tributaries" must NOT trip the guard. Cleanup
      // for this concert is covered by the describe's `afterAll` (its
      // source_id shares the `trib-` prefix).
      const concertId2 = await seedConcert('trib-raw2', {
        title: null,
        supporting_artists_raw: [`${ARTIST_PREFIX} Tributaries`],
      });
      await syncOneConcert(sql, concertId2, [`${ARTIST_PREFIX} Tributaries`]);
      const candidates2 = await loadSupportCandidates(sql);
      expect(candidates2.some((c) => c.raw_name === `${ARTIST_PREFIX} Tributaries`)).toBe(true);
    });
  });

  describe('has_resolved_support: windowed recompute-from-truth transitions', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}hrs-%`]);
    });

    it('resolve → tombstone → un-tombstone drives has_resolved_support true → false → true', async () => {
      await seedArtist(`${ARTIST_PREFIX} HRS Cycle`);
      const concertId = await seedConcert('hrs-cycle', { supporting_artists_raw: [`${ARTIST_PREFIX} HRS Cycle`] });

      // Before any support exists: false (default).
      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(concertId)).has_resolved_support).toBe(false);

      // Resolve → true.
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} HRS Cycle`]);
      await runSupportResolveOnce(sql);
      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(concertId)).has_resolved_support).toBe(true);

      // Array-shrink tombstones the only resolved support → false. This is
      // the down-transition a same-transaction boolean flip cannot handle
      // without decrement bookkeeping — the reason a windowed recompute
      // was chosen over an in-line flip.
      await syncOneConcert(sql, concertId, []);
      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(concertId)).has_resolved_support).toBe(false);

      // Reappearance un-tombstones the (already-resolved, artist_id
      // retained) row → true again, with NO re-resolve needed.
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} HRS Cycle`]);
      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(concertId)).has_resolved_support).toBe(true);
    });

    it('the dual-lane predicate: a discogs_artist_id-only support row ALSO counts as resolved', async () => {
      const concertId = await seedConcert('hrs-discogs-lane', {
        supporting_artists_raw: [`${ARTIST_PREFIX} Discogs Lane`],
      });
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} Discogs Lane`]);
      // Simulate the future Phase-D LML arm's write shape directly — no
      // library artist_id, just a bare Discogs id.
      await sql.unsafe(
        `UPDATE "${SCHEMA}".concert_performers SET "discogs_artist_id" = 999999001 WHERE "concert_id" = $1`,
        [concertId]
      );

      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(concertId)).has_resolved_support).toBe(true);
    });

    it('an ambiguous (unresolved) support row keeps has_resolved_support false', async () => {
      const dupName = `${ARTIST_PREFIX} HRS Ambiguous`;
      await seedArtist(dupName);
      await seedArtist(dupName);
      const concertId = await seedConcert('hrs-ambiguous', { supporting_artists_raw: [dupName] });
      await syncOneConcert(sql, concertId, [dupName]);
      await runSupportResolveOnce(sql);

      await recomputeHasResolvedSupport(sql);
      expect((await readConcert(concertId)).has_resolved_support).toBe(false);
    });

    it('recompute is idempotent: a second pass over unchanged state updates nothing', async () => {
      await seedConcert('hrs-idempotent', { supporting_artists_raw: [] });
      await recomputeHasResolvedSupport(sql); // first pass, sets false (already false — no-op via IS DISTINCT FROM)
      const updatedCount = await recomputeHasResolvedSupport(sql); // second pass
      expect(updatedCount).toBe(0);
    });
  });

  describe('end-to-end: sync → resolve → recompute', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}e2e-%`]);
    });

    it('a fresh concert with one resolvable support act ends fully resolved and curated-flagged', async () => {
      const artistId = await seedArtist(`${ARTIST_PREFIX} E2E Resolvable`);
      const concertId = await seedConcert('e2e-full', {
        supporting_artists_raw: [`${ARTIST_PREFIX} E2E Resolvable`, `${ARTIST_PREFIX} E2E Unmatched`],
      });

      // Step 1: sync.
      const syncOutcome = await syncOneConcert(sql, concertId, [
        `${ARTIST_PREFIX} E2E Resolvable`,
        `${ARTIST_PREFIX} E2E Unmatched`,
      ]);
      expect(syncOutcome.inserted).toBe(2);

      // Step 3: support resolve (step 2, headliner resolve, is unchanged
      // and untouched by this scenario — no headliner raw name seeded
      // needs resolving here).
      await runSupportResolveOnce(sql);

      // Step 4: recompute.
      await recomputeHasResolvedSupport(sql);

      const rows = await readPerformerRows(concertId);
      const resolvable = rows.find((r) => r.raw_name === `${ARTIST_PREFIX} E2E Resolvable`);
      const unmatched = rows.find((r) => r.raw_name === `${ARTIST_PREFIX} E2E Unmatched`);
      expect(Number(resolvable.artist_id)).toBe(artistId);
      expect(unmatched.artist_id).toBeNull();

      expect((await readConcert(concertId)).has_resolved_support).toBe(true);
    });

    it('a concert with only unresolvable support acts ends with has_resolved_support false', async () => {
      const concertId = await seedConcert('e2e-empty', {
        supporting_artists_raw: [`${ARTIST_PREFIX} E2E Nobody Knows`],
      });

      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} E2E Nobody Knows`]);
      await runSupportResolveOnce(sql);
      await recomputeHasResolvedSupport(sql);

      expect((await readConcert(concertId)).has_resolved_support).toBe(false);
    });

    it('a re-run of the full pipeline against unchanged state is a true no-op', async () => {
      const rawName = `${ARTIST_PREFIX} E2E Rerun Act`;
      const artistId = await seedArtist(rawName);
      const concertId = await seedConcert('e2e-rerun', { supporting_artists_raw: [rawName] });

      await syncOneConcert(sql, concertId, [rawName]);
      await runSupportResolveOnce(sql);
      await recomputeHasResolvedSupport(sql);

      // Second full pass: sync sees steady state, resolve sees no
      // candidates FOR THIS ROW, recompute sees no diff. `runSupportResolveOnce`
      // scans every `bs1760:%`-prefixed concert (faithful to the real
      // job's global scan), so asserting on ITS raw totals here would be
      // cross-test-fragile — an earlier describe block's deliberately
      // unresolved fixture (e.g. "E2E Nobody Knows") is a legitimate
      // perpetual `unmatched` candidate for the rest of the file. Assert
      // on THIS test's own row instead, mirroring the scoped-candidate
      // check in the "support resolve arm" describe's idempotent-re-run
      // case.
      const syncOutcome = await syncOneConcert(sql, concertId, [rawName]);
      expect(syncOutcome).toEqual({ inserted: 0, untombstoned: 0, tombstoned: 0 });

      const candidates = await loadSupportCandidates(sql);
      expect(candidates.some((c) => c.raw_name === rawName)).toBe(false);

      await runSupportResolveOnce(sql); // global scan; no-op for this row either way
      const rows = await readPerformerRows(concertId);
      expect(Number(rows[0].artist_id)).toBe(artistId); // unchanged, not re-touched

      const recomputeCount = await recomputeHasResolvedSupport(sql);
      expect(recomputeCount).toBe(0);
    });
  });

  describe('candidate scope independently filters the parent concert tombstone', () => {
    afterAll(async () => {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".concerts WHERE source_id LIKE $1`, [`${SOURCE_ID_PREFIX}tomb-%`]);
    });

    it('a support row on a TOMBSTONED concert is excluded from resolve candidacy even though the junction row itself is active', async () => {
      const concertId = await seedConcert('tomb-parent', {
        supporting_artists_raw: [`${ARTIST_PREFIX} Orphaned By Tombstone`],
      });
      await syncOneConcert(sql, concertId, [`${ARTIST_PREFIX} Orphaned By Tombstone`]);
      await seedArtist(`${ARTIST_PREFIX} Orphaned By Tombstone`);

      // Tombstone the PARENT concert directly — the junction row's own
      // removed_at stays NULL (it doesn't cascade on a soft-delete).
      await sql.unsafe(`UPDATE "${SCHEMA}".concerts SET "removed_at" = now() WHERE "id" = $1`, [concertId]);

      const candidates = await loadSupportCandidates(sql);
      expect(candidates.some((c) => c.raw_name === `${ARTIST_PREFIX} Orphaned By Tombstone`)).toBe(false);

      // The recompute window also independently excludes it.
      const before = await readConcert(concertId);
      await recomputeHasResolvedSupport(sql);
      const after = await readConcert(concertId);
      expect(after.has_resolved_support).toBe(before.has_resolved_support);
    });
  });
});
