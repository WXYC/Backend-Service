/**
 * Integration test for the BS#2281 dj_name scrub, against real Postgres.
 *
 * ## What this tier covers, and what it deliberately does not
 *
 * The scrub's DECISION logic (`decideDjName`, `buildPiiNameIndex`,
 * `rewriteMessage`) is pure TypeScript and is covered in the unit tier
 * against the REAL `@wxyc/database` helpers — `tests/mocks/database.mock.ts`
 * re-exports `resolveShowDjName` / `resolveDjDisplayName` /
 * `showDjNameOverride` from source rather than stubbing them, so that
 * coverage is genuine rather than self-referential. It is not re-derived here:
 * the integration runner is babel-jest with no TS transform (same constraint
 * `flowsheet-artwork-repair.spec.js` and `concerts-artist-resolver-support.spec.js`
 * document), and hand-mirroring the decision in JS would create exactly the
 * second copy of the chain this job's whole design exists to avoid.
 *
 * What only real PG can prove, and what this file pins:
 *
 *   1. The candidate SELECTs cannot even SEE the excluded entry types
 *      (`talkset` / `breakpoint` / `message`), so a decision bug cannot reach
 *      them. This is defense in depth over the unit-tier exclusion test.
 *   2. `user_found` genuinely distinguishes "no user row" from "a user row
 *      with an unusable handle" — the two branches of `resolveShowDjName`
 *      that trim `legacy_dj_name` DIFFERENTLY. A collapsed boolean here would
 *      silently change bytes on the public wire.
 *   3. The untrimmed legacy handle survives the round trip verbatim.
 *   4. The VALUES-join UPDATE applies per-row values and its
 *      `IS NOT DISTINCT FROM` compare-and-set no-ops when another writer moved
 *      the row first.
 *   5. `search_doc` is recomputed by the same UPDATE — the load-bearing claim
 *      behind "no separate reindex step". Only a real generated column can
 *      demonstrate this.
 *   6. `updated_at` advances via migration 0084's BEFORE UPDATE trigger even
 *      though the job never names that column.
 *
 * SQL here mirrors `jobs/flowsheet-dj-name-scrub/orchestrate.ts`. When the
 * queries there change, these must follow.
 *
 * Note the binding convention inversion: `getTestDb()` is postgres-js, where a
 * bare JS array IS correctly bound as a PG array. The `intArrayLiteral` helper
 * (BS#2010) is required in the job's Drizzle `sql` templates and is WRONG
 * here — `docs/bulk-update-playbook.md` flags precisely this trap.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const IN_SCOPE_ENTRY_TYPES = ['track', 'show_start', 'show_end', 'dj_join', 'dj_leave'];
const MESSAGE_ENTRY_TYPES = ['show_start', 'show_end', 'dj_join', 'dj_leave'];

/** Mirrors `loadMainPage` in orchestrate.ts. */
async function loadMainPage(sql, afterId, batchSize) {
  return sql`
    SELECT f."id", f."entry_type", f."dj_name", f."message", f."show_id",
           s."dj_name_override", s."legacy_dj_name", s."primary_dj_id",
           (u."id" IS NOT NULL) AS "user_found", u."dj_name" AS "user_dj_name"
      FROM ${sql(SCHEMA)}.flowsheet AS f
      JOIN ${sql(SCHEMA)}.shows AS s ON s."id" = f."show_id"
      LEFT JOIN auth_user AS u ON u."id" = s."primary_dj_id"
     WHERE f."id" > ${afterId}
       AND f."entry_type" = ANY(${IN_SCOPE_ENTRY_TYPES}::${sql.unsafe(SCHEMA)}.flowsheet_entry_type[])
     ORDER BY f."id"
     LIMIT ${batchSize}
  `;
}

/** Mirrors `loadOrphanPage` in orchestrate.ts. */
async function loadOrphanPage(sql, afterId, batchSize) {
  return sql`
    SELECT f."id", f."entry_type", f."dj_name", f."message", f."show_id"
      FROM ${sql(SCHEMA)}.flowsheet AS f
     WHERE f."id" > ${afterId}
       AND f."show_id" IS NULL
       AND f."dj_name" IS NOT NULL
       AND f."entry_type" = ANY(${IN_SCOPE_ENTRY_TYPES}::${sql.unsafe(SCHEMA)}.flowsheet_entry_type[])
     ORDER BY f."id"
     LIMIT ${batchSize}
  `;
}

/** Mirrors `loadMessagePage` in orchestrate.ts. */
async function loadMessagePage(sql, afterId, batchSize) {
  return sql`
    SELECT f."id", f."entry_type", f."message"
      FROM ${sql(SCHEMA)}.flowsheet AS f
     WHERE f."id" > ${afterId}
       AND f."message" IS NOT NULL
       AND f."entry_type" = ANY(${MESSAGE_ENTRY_TYPES}::${sql.unsafe(SCHEMA)}.flowsheet_entry_type[])
     ORDER BY f."id"
     LIMIT ${batchSize}
  `;
}

/**
 * Mirrors `applyDjNameBatch`. `fixes` is `[{ id, djName, oldDjName }]`.
 * `updated_at` is deliberately absent from the SET list — the migration-0084
 * trigger owns it.
 */
async function applyDjNameBatch(sql, fixes) {
  if (fixes.length === 0) return 0;
  const values = fixes.map((f) => [f.id, f.djName, f.oldDjName]);
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.flowsheet AS t
       SET "dj_name" = v."dj_name"
      FROM (VALUES ${sql(values)}) AS v("id", "dj_name", "old_dj_name")
     WHERE t."id" = v."id"::int
       AND t."dj_name" IS NOT DISTINCT FROM v."old_dj_name"::text
    RETURNING t."id"
  `;
  return rows.length;
}

const USERS = [
  // No handle at all — the Cohort A shape. Its real name IS the leak.
  { id: 'scrub-u-handleless', name: 'Realname Alpha', dj_name: null, email: 'scrub-alpha@example.test' },
  // A usable handle distinct from the real name.
  { id: 'scrub-u-handled', name: 'Realname Beta', dj_name: 'zorp', email: 'scrub-beta@example.test' },
];

let showLiveId;
let showLegacyId;
let showOverrideId;
const seededFlowsheetIds = [];

describe('flowsheet-dj-name-scrub SQL contract (BS#2281)', () => {
  const sql = getTestDb();

  beforeAll(async () => {
    for (const u of USERS) {
      await sql`
        INSERT INTO auth_user ("id", "name", "email", "dj_name")
        VALUES (${u.id}, ${u.name}, ${u.email}, ${u.dj_name})
        ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "dj_name" = EXCLUDED."dj_name"
      `;
    }

    const live = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows ("primary_dj_id", "legacy_dj_name")
      VALUES ('scrub-u-handled', 'live legacy handle') RETURNING "id"
    `;
    showLiveId = live[0].id;

    // The legacy cohort: no primary_dj_id, so no user row to read. Its
    // legacy_dj_name is deliberately padded to exercise the UNTRIMMED branch.
    const legacy = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows ("primary_dj_id", "legacy_dj_name")
      VALUES (NULL, '  untrimmed legacy  ') RETURNING "id"
    `;
    showLegacyId = legacy[0].id;

    const override = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows ("primary_dj_id", "legacy_dj_name", "dj_name_override")
      VALUES ('scrub-u-handled', 'ignored legacy', 'Override Name') RETURNING "id"
    `;
    showOverrideId = override[0].id;

    const seed = async (row) => {
      const inserted = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet
          ("show_id", "entry_type", "dj_name", "message", "play_order", "artist_name")
        VALUES (${row.show_id}, ${row.entry_type}::${sql.unsafe(SCHEMA)}.flowsheet_entry_type,
                ${row.dj_name ?? null}, ${row.message ?? null}, ${row.play_order}, ${row.artist_name ?? null})
        RETURNING "id"
      `;
      seededFlowsheetIds.push(inserted[0].id);
      return inserted[0].id;
    };

    // Rows the scrub must consider.
    await seed({
      show_id: showLiveId,
      entry_type: 'track',
      dj_name: 'Realname Beta',
      play_order: 1,
      artist_name: 'Juana Molina',
    });
    await seed({ show_id: showLiveId, entry_type: 'show_start', dj_name: 'Realname Beta', play_order: 2 });
    await seed({ show_id: showLiveId, entry_type: 'show_end', dj_name: 'Realname Beta', play_order: 3 });
    await seed({
      show_id: showLiveId,
      entry_type: 'dj_join',
      dj_name: 'guest handle',
      message: 'guest handle joined the set!',
      play_order: 4,
    });
    await seed({
      show_id: showLegacyId,
      entry_type: 'track',
      dj_name: 'Realname Alpha',
      play_order: 1,
      artist_name: 'Jessica Pratt',
    });
    await seed({ show_id: showLegacyId, entry_type: 'show_start', dj_name: 'Realname Alpha', play_order: 2 });
    await seed({
      show_id: showOverrideId,
      entry_type: 'track',
      dj_name: 'stale',
      play_order: 1,
      artist_name: 'Stereolab',
    });

    // Rows the scrub must NEVER touch.
    await seed({ show_id: showLiveId, entry_type: 'talkset', dj_name: null, play_order: 5 });
    await seed({ show_id: showLiveId, entry_type: 'breakpoint', dj_name: null, play_order: 6 });
    await seed({
      show_id: showLiveId,
      entry_type: 'message',
      dj_name: null,
      message: 'a station message',
      play_order: 7,
    });

    // An orphan: no show, so no chain to recompute from.
    await seed({
      show_id: null,
      entry_type: 'track',
      dj_name: 'Realname Alpha',
      play_order: 1,
      artist_name: 'Cat Power',
    });
    // An orphan of an excluded type, to prove exclusion outranks the orphan pass.
    await seed({ show_id: null, entry_type: 'talkset', dj_name: 'Realname Alpha', play_order: 2 });
  });

  afterAll(async () => {
    if (seededFlowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE "id" = ANY(${seededFlowsheetIds})`;
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE "id" = ANY(${[showLiveId, showLegacyId, showOverrideId].filter(Boolean)})`;
    await sql`DELETE FROM auth_user WHERE "id" = ANY(${USERS.map((u) => u.id)})`;
  });

  describe('candidate selection', () => {
    it('never surfaces an excluded entry type to the main pass', async () => {
      const rows = await loadMainPage(sql, 0, 1000);
      const seeded = rows.filter((r) => seededFlowsheetIds.includes(r.id));
      expect(seeded.length).toBeGreaterThan(0);
      for (const row of seeded) {
        expect(['talkset', 'breakpoint', 'message']).not.toContain(row.entry_type);
      }
    });

    it('never surfaces an excluded entry type to the orphan pass', async () => {
      const rows = await loadOrphanPage(sql, 0, 1000);
      const seeded = rows.filter((r) => seededFlowsheetIds.includes(r.id));
      // The orphan track row is in; the orphan talkset row is not, even though
      // it holds a real name. Exclusion outranks PII removal by design — a
      // talkset row is never attributed to a DJ, so writing one is worse.
      expect(seeded.map((r) => r.entry_type)).toEqual(['track']);
    });

    it('scopes the orphan pass to show_id IS NULL with a non-null dj_name', async () => {
      const rows = await loadOrphanPage(sql, 0, 1000);
      for (const row of rows) {
        expect(row.show_id).toBeNull();
        expect(row.dj_name).not.toBeNull();
      }
    });

    it('scopes the message pass to the four marker types', async () => {
      const rows = await loadMessagePage(sql, 0, 1000);
      const seeded = rows.filter((r) => seededFlowsheetIds.includes(r.id));
      for (const row of seeded) {
        expect(MESSAGE_ENTRY_TYPES).toContain(row.entry_type);
        expect(row.message).not.toBeNull();
      }
      // The seeded `message`-type row carries text but is not a marker.
      expect(seeded.map((r) => r.entry_type)).not.toContain('message');
    });
  });

  describe('the join columns the canonical chain reads', () => {
    it('reports user_found=false for the legacy cohort and true for a linked show', async () => {
      // This distinction is not cosmetic: resolveShowDjName returns
      // legacy_dj_name UNTRIMMED when there is no user row, and TRIMMED when
      // there is one whose handle is unusable.
      const rows = await loadMainPage(sql, 0, 1000);
      const legacy = rows.find((r) => r.show_id === showLegacyId);
      const live = rows.find((r) => r.show_id === showLiveId);

      expect(legacy.user_found).toBe(false);
      expect(legacy.primary_dj_id).toBeNull();
      expect(live.user_found).toBe(true);
      expect(live.user_dj_name).toBe('zorp');
    });

    it('returns the legacy handle byte-for-byte, padding included', async () => {
      const rows = await loadMainPage(sql, 0, 1000);
      const legacy = rows.find((r) => r.show_id === showLegacyId);
      expect(legacy.legacy_dj_name).toBe('  untrimmed legacy  ');
    });

    it('surfaces the per-show override', async () => {
      const rows = await loadMainPage(sql, 0, 1000);
      const overridden = rows.find((r) => r.show_id === showOverrideId);
      expect(overridden.dj_name_override).toBe('Override Name');
    });
  });

  describe('the write path', () => {
    it('applies a different value per row in one statement', async () => {
      const rows = await loadMainPage(sql, 0, 1000);
      const trackLive = rows.find((r) => r.show_id === showLiveId && r.entry_type === 'track');
      const trackOverride = rows.find((r) => r.show_id === showOverrideId && r.entry_type === 'track');

      const written = await applyDjNameBatch(sql, [
        { id: trackLive.id, djName: 'zorp', oldDjName: trackLive.dj_name },
        { id: trackOverride.id, djName: 'Override Name', oldDjName: trackOverride.dj_name },
      ]);
      expect(written).toBe(2);

      const after = await sql`
        SELECT "id", "dj_name" FROM ${sql(SCHEMA)}.flowsheet
         WHERE "id" = ANY(${[trackLive.id, trackOverride.id]}) ORDER BY "id"
      `;
      const byId = Object.fromEntries(after.map((r) => [r.id, r.dj_name]));
      expect(byId[trackLive.id]).toBe('zorp');
      expect(byId[trackOverride.id]).toBe('Override Name');
    });

    it('writes NULL where the chain resolves to nothing', async () => {
      const rows = await loadMainPage(sql, 0, 1000);
      const guestJoin = rows.find((r) => r.show_id === showLiveId && r.entry_type === 'dj_join');

      const written = await applyDjNameBatch(sql, [{ id: guestJoin.id, djName: null, oldDjName: guestJoin.dj_name }]);
      expect(written).toBe(1);

      const after = await sql`SELECT "dj_name" FROM ${sql(SCHEMA)}.flowsheet WHERE "id" = ${guestJoin.id}`;
      expect(after[0].dj_name).toBeNull();
    });

    it('no-ops when another writer moved the row first (the compare-and-set)', async () => {
      // Two live writers still re-derive the chain in SQL
      // (jobs/flowsheet-etl/job.ts:121, apps/backend/routes/internal.route.ts:195)
      // and a page can sit unwritten for a long time under cooperative pause.
      // Without the CAS this job would clobber their value.
      const rows = await loadMainPage(sql, 0, 1000);
      const target = rows.find((r) => r.show_id === showLegacyId && r.entry_type === 'track');

      await sql`UPDATE ${sql(SCHEMA)}.flowsheet SET "dj_name" = 'written by someone else' WHERE "id" = ${target.id}`;

      const written = await applyDjNameBatch(sql, [
        { id: target.id, djName: 'scrub value', oldDjName: target.dj_name },
      ]);
      expect(written).toBe(0);

      const after = await sql`SELECT "dj_name" FROM ${sql(SCHEMA)}.flowsheet WHERE "id" = ${target.id}`;
      expect(after[0].dj_name).toBe('written by someone else');
    });

    it('recomputes search_doc as part of the same UPDATE — no separate reindex', async () => {
      // search_doc is STORED GENERATED over an expression containing dj_name
      // (schema.ts:1295), which is the entire basis for this job having no
      // reindex step. Migration 0054 relies on the same property.
      const rows = await loadMainPage(sql, 0, 1000);
      const target = rows.find((r) => r.show_id === showLegacyId && r.entry_type === 'show_start');

      await applyDjNameBatch(sql, [{ id: target.id, djName: 'searchableafterscrub', oldDjName: target.dj_name }]);

      const [{ matched }] = await sql`
        SELECT (search_doc @@ to_tsquery('simple', 'searchableafterscrub')) AS matched
          FROM ${sql(SCHEMA)}.flowsheet WHERE "id" = ${target.id}
      `;
      expect(matched).toBe(true);

      // ...and the pre-scrub real name is no longer a search key.
      const [{ stillMatches }] = await sql`
        SELECT (search_doc @@ to_tsquery('simple', 'realname')) AS "stillMatches"
          FROM ${sql(SCHEMA)}.flowsheet WHERE "id" = ${target.id}
      `;
      expect(stillMatches).toBe(false);
    });

    it('advances updated_at via the migration-0084 trigger, not the job', async () => {
      const rows = await loadMainPage(sql, 0, 1000);
      const target = rows.find((r) => r.show_id === showLiveId && r.entry_type === 'show_end');

      const before = await sql`SELECT "updated_at" FROM ${sql(SCHEMA)}.flowsheet WHERE "id" = ${target.id}`;
      await applyDjNameBatch(sql, [{ id: target.id, djName: 'zorp', oldDjName: target.dj_name }]);
      const after = await sql`SELECT "updated_at" FROM ${sql(SCHEMA)}.flowsheet WHERE "id" = ${target.id}`;

      expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(new Date(before[0].updated_at).getTime());
    });

    it('leaves every excluded row untouched after the full pass', async () => {
      const excluded = await sql`
        SELECT "entry_type", "dj_name" FROM ${sql(SCHEMA)}.flowsheet
         WHERE "id" = ANY(${seededFlowsheetIds})
           AND "entry_type" = ANY(${['talkset', 'breakpoint', 'message']}::${sql.unsafe(SCHEMA)}.flowsheet_entry_type[])
         ORDER BY "id"
      `;
      // Three seeded on a show (deliberately NULL — must not be POPULATED),
      // one orphan holding a real name (excluded outranks the PII probe).
      expect(excluded).toHaveLength(4);
      const onShow = excluded.filter((r) => r.dj_name === null);
      expect(onShow).toHaveLength(3);
      expect(excluded.filter((r) => r.dj_name === 'Realname Alpha')).toHaveLength(1);
    });
  });
});
