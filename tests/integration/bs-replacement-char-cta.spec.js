/**
 * Correctness pin for scripts/audit/bs_replacement_char_cta.sql (BS#2152).
 *
 * Unlike its three predecessors (bs_replacement_char_recovery.sql,
 * _phase35.sql, _phase4.spec.js), the CTA script's 14 real corrupt/correct
 * pairs cannot be enumerated locally -- dev_env/seed-clone.sql carries no
 * `compilation_track_artist` rows at all (see the script's own header), so
 * the script ships with a `pending_cta_repair` block holding zero real rows.
 * That means the verification burden here is entirely on THIS spec: it runs
 * the REAL mechanism statements extracted from the script file (schema-
 * substituted into a throwaway schema, same technique as
 * bs-replacement-char-phase4.spec.js's `extractUpdates`), then feeds them
 * synthetic pending rows built from WXYC-representative fixture data so the
 * twin-aware DELETE/UPDATE branching, the idempotency guarantee, the
 * NULL-track_title loophole (migration 0099 / `cta_unique_null_track_idx`),
 * and every operator-error guard are all exercised against the actual
 * DDL/DML the operator will run -- only the pending DATA differs between
 * this spec and prod.
 *
 * The throwaway `compilation_track_artist` table replicates BOTH production
 * unique indexes (`cta_unique_idx` and its NULL-track_title complement) --
 * unlike bs-replacement-char-phase4.spec.js's plain `text` columns, that
 * replication is load-bearing here: the whole point of the twin-aware design
 * is "never let a write hit a unique violation", and that claim is only
 * actually tested if the constraint exists to violate. It also carries the
 * BS#1990 (#801 S1) identity-link columns (`track_artist_id` +
 * `track_artist_link_confidence` + `track_artist_link_method`) with the same
 * varchar(255)/varchar(20) lengths as prod (PR #2154 review NIT) -- plain
 * `text` would silently accept a captured value too long for the real
 * column.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

const TEST_SCHEMA = 'bs2152_cta_mojibake_test';
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'audit', 'bs_replacement_char_cta.sql');

// The exact block names the script must carry, in the order the mechanism
// requires them to run. A future edit that adds/removes/renames a block
// fails this extraction loudly instead of silently testing a stale shape.
const EXPECTED_BLOCKS = [
  'create-pending-table',
  'insert-pending-rows',
  'guard-placeholder-scrub',
  'guard-replacement-specified',
  'guard-capture-sanity',
  'build-targets',
  'guard-ambiguous-match',
  'guard-converging-pending',
  'repoint-twin-identity',
  'delete-twins',
  'update-no-twins',
  'analyze',
];

/**
 * Pull the `-- === STMT: <name> === ... -- === END STMT ===`-delimited
 * blocks out of the operator script and retarget every `wxyc_schema.`
 * reference at the throwaway schema. Each block is executed verbatim via
 * `sql.unsafe` -- no re-parsing of individual statements, so a block
 * containing a `DO $$ ... $$;` (whose body has its own internal semicolons)
 * is never mis-split. The explicit `END STMT` marker (rather than "runs
 * until the next STMT marker") matters: several blocks in this script are
 * followed by unmarked prose/SELECTs -- including a bare `BEGIN;` starting
 * the transactional write section -- that must NOT be swept into the
 * preceding block. Executing a literal `BEGIN;` over this spec's pooled
 * connection trips postgres-js's own cross-connection-transaction guard
 * (`UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`), which
 * is exactly what caught this the first time this extractor was written
 * without END markers.
 *
 * The start-marker name pattern is `[a-z0-9_-]+`, not just `[a-z-]+`
 * (PR #2154 review, finding 5): the narrower pattern silently skips any
 * future block named with a digit or underscore -- it simply never matches
 * as a start, so that block's own content gets swept into whichever
 * preceding block IS recognized, and the mis-shapen result would still pass
 * the name-list assertion below as long as EXPECTED_BLOCKS was (wrongly)
 * left in sync with the truncated `names` list. Widening the pattern makes
 * that class of block silently disappearing structurally impossible instead
 * of merely unlikely.
 */
function extractStmtBlocks(scriptText, targetSchema) {
  const startRe = /^--\s*===\s*STMT:\s*([a-z0-9_-]+)\s*===\s*$/gm;
  const endRe = /^--\s*===\s*END STMT\s*===\s*$/gm;
  const starts = [];
  let m;
  while ((m = startRe.exec(scriptText)) !== null) {
    starts.push({ name: m[1], contentStart: m.index + m[0].length });
  }
  const names = starts.map((s) => s.name);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_BLOCKS)) {
    throw new Error(
      `expected bs_replacement_char_cta.sql STMT blocks ${JSON.stringify(EXPECTED_BLOCKS)}, found ${JSON.stringify(names)}`
    );
  }

  const blocks = {};
  for (const { name, contentStart } of starts) {
    endRe.lastIndex = contentStart;
    const endMatch = endRe.exec(scriptText);
    if (!endMatch) {
      throw new Error(`STMT block "${name}" has no matching "-- === END STMT ===" marker`);
    }
    blocks[name] = scriptText.slice(contentStart, endMatch.index).replace(/wxyc_schema\./g, `${targetSchema}.`);
  }
  return blocks;
}

describe('bs_replacement_char_cta mojibake repair (BS#2152)', () => {
  let sql;
  let blocks;
  let scriptText;

  beforeAll(async () => {
    sql = getTestDb();
    scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8');
    blocks = extractStmtBlocks(scriptText, TEST_SCHEMA);

    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.library (
        id serial PRIMARY KEY,
        legacy_release_id integer UNIQUE NOT NULL
      )
    `);
    // Column types match prod (shared/database/src/schema.ts:698) --
    // varchar(255)/varchar(20), not `text` (PR #2154 review NIT) -- so a
    // captured value too long for the real column would fail here the same
    // way it would against prod, not silently succeed against a laxer
    // throwaway shape. Also carries the BS#1990 (#801 S1) identity-link
    // columns the repoint-twin-identity statement reads/writes.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.compilation_track_artist (
        id serial PRIMARY KEY,
        library_id integer NOT NULL,
        artist_name varchar(255) NOT NULL,
        track_title varchar(255),
        track_position varchar(20),
        track_artist_id integer,
        track_artist_link_confidence real,
        track_artist_link_method text
      )
    `);
    // Replicates BOTH production unique constraints (schema.ts:731 +
    // migration 0099) so "no unique violation is raised" is a real assertion,
    // not a vacuous one -- a bug that ran UPDATE instead of DELETE on a twin
    // row would actually throw 23505 against this schema.
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS cta_test_unique_idx
        ON ${TEST_SCHEMA}.compilation_track_artist (library_id, artist_name, track_title)
    `);
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS cta_test_unique_null_track_idx
        ON ${TEST_SCHEMA}.compilation_track_artist (library_id, artist_name)
        WHERE track_title IS NULL
    `);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE ${TEST_SCHEMA}.library, ${TEST_SCHEMA}.compilation_track_artist RESTART IDENTITY CASCADE`
    );
  });

  /**
   * Insert synthetic pending rows via a plain INSERT (NOT the script's own
   * `insert-pending-rows` block, which as shipped only knows how to insert
   * its own hardcoded placeholder). Unqualified, deliberately --
   * `pending_cta_repair` is a TEMP TABLE, so it lives in this session's
   * `pg_temp_N` schema, not `TEST_SCHEMA`. Schema-qualifying it here would
   * look identical to qualifying an ordinary table and fail with "relation
   * does not exist" despite the table genuinely existing on this connection.
   *
   * `sql(array, ...columns)` generates the WHOLE `(columns…) VALUES (…),
   * (…)` fragment as one unit -- it is not just a values-list helper.
   * Writing an explicit column list before it (as a plain `sql`
   * tagged-template author would reasonably try first) silently produces a
   * mismatched column/value count ("INSERT has more target columns than
   * expressions"), because postgres-js then emits its own column list a
   * second time inside the substitution.
   */
  async function insertSyntheticPendingRows(reservedSql, pendingRows) {
    if (pendingRows.length === 0) return;
    await reservedSql`
      INSERT INTO pending_cta_repair ${reservedSql(
        pendingRows.map((r) => ({
          legacy_release_id: r.legacy_release_id,
          track_position: r.track_position ?? null,
          current_artist_name: r.current_artist_name,
          current_track_title: r.current_track_title ?? null,
          true_artist_name: r.true_artist_name ?? null,
          true_track_title: r.true_track_title ?? null,
        })),
        'legacy_release_id',
        'track_position',
        'current_artist_name',
        'current_track_title',
        'true_artist_name',
        'true_track_title'
      )}
    `;
  }

  /**
   * Run the script's actual mechanism end to end -- every STMT block, plus
   * the literal `BEGIN`/`SET LOCAL statement_timeout`/`COMMIT` control
   * statements that sit between them in the file but aren't themselves
   * STMT-tagged (PR #2154 review, finding 5: a prior version of this spec
   * never executed those, so a bug that only manifested inside the real
   * transaction boundary -- e.g. an aborted-transaction state leaking into
   * the next statement -- had no coverage). `insertPhase` supplies whichever
   * pending-row insertion the caller wants (synthetic fixture rows, or the
   * literal shipped `insert-pending-rows` block) so both paths share the
   * exact same guard/classify/write sequence.
   *
   * `pending_cta_repair` and `cta_repair_targets` are TEMP TABLEs -- session
   * scoped, exactly like they are when an operator runs this script through
   * one `psql -f` connection. `getTestDb()` returns a POOL (max: 5), so
   * spreading these statements across ordinary pooled queries would create
   * the temp table on one physical connection and then fail to find it on
   * another. `sql.reserve()` pins one connection for the whole run, the same
   * single-session guarantee prod gets -- which is also why running the
   * real `BEGIN`/`COMMIT` here is safe: this is a dedicated reserved
   * connection, not the shared pool the extractor's own comment warns about.
   */
  async function runRepairScript(insertPhase) {
    const reservedSql = await sql.reserve();
    let inTransaction = false;
    try {
      await reservedSql.unsafe(blocks['create-pending-table']);
      await insertPhase(reservedSql);
      await reservedSql.unsafe(blocks['guard-placeholder-scrub']);
      await reservedSql.unsafe(blocks['guard-replacement-specified']);
      await reservedSql.unsafe(blocks['guard-capture-sanity']);

      await reservedSql.unsafe('BEGIN');
      inTransaction = true;
      await reservedSql.unsafe("SET LOCAL statement_timeout = '30s'");
      await reservedSql.unsafe(blocks['build-targets']);
      await reservedSql.unsafe(blocks['guard-ambiguous-match']);
      await reservedSql.unsafe(blocks['guard-converging-pending']);
      await reservedSql.unsafe(blocks['repoint-twin-identity']);
      const deleteResult = await reservedSql.unsafe(blocks['delete-twins']);
      const updateResult = await reservedSql.unsafe(blocks['update-no-twins']);
      await reservedSql.unsafe('COMMIT');
      inTransaction = false;

      await reservedSql.unsafe(blocks['analyze']);
      return { deleted: deleteResult.count, updated: updateResult.count };
    } catch (err) {
      // A guard RAISE EXCEPTION (or a real constraint violation) inside the
      // transaction aborts it server-side; roll back explicitly so this
      // reserved connection isn't handed back to the pool mid-aborted-
      // transaction for the next test to trip over.
      if (inTransaction) {
        await reservedSql.unsafe('ROLLBACK');
      }
      throw err;
    } finally {
      reservedSql.release();
    }
  }

  const withSyntheticPendingRows = (pendingRows) => (reservedSql) =>
    insertSyntheticPendingRows(reservedSql, pendingRows);

  async function seedLibrary(legacyReleaseId) {
    const rows = await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id) VALUES (${legacyReleaseId})
      RETURNING id
    `;
    return rows[0].id;
  }

  async function seedCta(libraryId, artistName, trackTitle, trackPosition, identity = {}) {
    const rows = await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.compilation_track_artist
        (library_id, artist_name, track_title, track_position, track_artist_id, track_artist_link_confidence, track_artist_link_method)
      VALUES (
        ${libraryId}, ${artistName}, ${trackTitle}, ${trackPosition},
        ${identity.track_artist_id ?? null}, ${identity.track_artist_link_confidence ?? null}, ${identity.track_artist_link_method ?? null}
      )
      RETURNING id
    `;
    return rows[0].id;
  }

  async function ctaRow(id) {
    const rows = await sql`
      SELECT artist_name, track_title, track_position, track_artist_id, track_artist_link_confidence, track_artist_link_method
      FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${id}
    `;
    return rows[0];
  }

  async function ctaCount(libraryId) {
    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE library_id = ${libraryId}
    `;
    return rows[0].n;
  }

  test('extracts exactly the 12 expected STMT blocks, in order', () => {
    expect(Object.keys(blocks)).toEqual(EXPECTED_BLOCKS);
    for (const name of EXPECTED_BLOCKS) {
      expect(blocks[name].trim().length).toBeGreaterThan(0);
    }
  });

  test('the file carries a literal BEGIN; and COMMIT; outside any STMT block (pinned so the runner above stays honest)', () => {
    expect(scriptText).toMatch(/^BEGIN;$/m);
    expect(scriptText).toMatch(/^COMMIT;$/m);
  });

  test('the shipped insert-pending-rows block (as committed) is a genuine no-op', async () => {
    const libraryId = await seedLibrary(90011);
    const cleanId = await seedCta(libraryId, 'Jessica Pratt', 'Back, Baby', '1');

    // Runs the LITERAL shipped block -- its own hardcoded placeholder INSERT
    // plus its own scrub DELETE -- not a harness-constructed substitute
    // (PR #2154 review, finding 5: the block an operator hand-edits with 14
    // real rows previously had zero execution coverage).
    const result = await runRepairScript(async (reservedSql) => {
      await reservedSql.unsafe(blocks['insert-pending-rows']);
    });

    expect(result.deleted).toBe(0);
    expect(result.updated).toBe(0);
    expect(await ctaCount(libraryId)).toBe(1);
    const row = await ctaRow(cleanId);
    expect(row.artist_name).toBe('Jessica Pratt');
  });

  test('corrupt track_title WITH a clean twin: DELETEs the corrupt row, raises no unique violation', async () => {
    const libraryId = await seedLibrary(90001);
    // The clean twin -- what the ETL's insert-only writer left behind
    // alongside the corrupt paste.
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '2');
    // The corrupt row: same artist, corrupted track_title, different position.
    const corruptId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '7');

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90001,
          track_position: '7',
          current_artist_name: 'Hermanos Gutiérrez',
          current_track_title: 'Sonido C�smico',
          true_track_title: 'Sonido Cósmico',
        },
      ])
    );

    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(0);
    // The corrupt row is gone...
    const remaining = await sql`
      SELECT id FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${corruptId}
    `;
    expect(remaining).toHaveLength(0);
    // ...the twin is untouched and is now the sole holder of the truth.
    const twin = await ctaRow(twinId);
    expect(twin.track_title).toBe('Sonido Cósmico');
    expect(await ctaCount(libraryId)).toBe(1);
  });

  test('corrupt track_title WITHOUT a twin: UPDATEs to the exact expected string', async () => {
    const libraryId = await seedLibrary(90002);
    const corruptId = await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90002,
          track_position: '4',
          current_artist_name: 'Csillagrablók',
          current_track_title: 'Rem�nytelen T�nc',
          true_track_title: 'Reménytelen Tánc',
        },
      ])
    );

    expect(result.deleted).toBe(0);
    expect(result.updated).toBe(1);
    const row = await ctaRow(corruptId);
    expect(row.artist_name).toBe('Csillagrablók');
    expect(row.track_title).toBe('Reménytelen Tánc');
  });

  test('a clean row not named in the pending block is left untouched', async () => {
    const libraryId = await seedLibrary(90003);
    const cleanId = await seedCta(libraryId, 'Chuquimamani-Condori', 'Call Your Name', '1');

    const result = await runRepairScript(withSyntheticPendingRows([]));

    expect(result.deleted).toBe(0);
    expect(result.updated).toBe(0);
    const row = await ctaRow(cleanId);
    expect(row.artist_name).toBe('Chuquimamani-Condori');
    expect(row.track_title).toBe('Call Your Name');
  });

  test('a decoy row sharing the exact corrupt track_title under a DIFFERENT artist is left untouched', async () => {
    // Same track title mis-transcribed identically for two different
    // performers on the same compilation track (the multi-performer shape
    // schema.ts's cta_unique_idx comment documents) -- the match must key on
    // BOTH artist_name and track_title, not track_title alone.
    const libraryId = await seedLibrary(90004);
    const targetId = await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');
    const decoyId = await seedCta(libraryId, 'Sonido Dueñez', 'Rem�nytelen T�nc', '5');

    await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90004,
          track_position: '4',
          current_artist_name: 'Csillagrablók',
          current_track_title: 'Rem�nytelen T�nc',
          true_track_title: 'Reménytelen Tánc',
        },
      ])
    );

    const target = await ctaRow(targetId);
    expect(target.track_title).toBe('Reménytelen Tánc');
    const decoy = await ctaRow(decoyId);
    expect(decoy.artist_name).toBe('Sonido Dueñez');
    expect(decoy.track_title).toBe('Rem�nytelen T�nc'); // still corrupt -- untouched
  });

  test('NULL track_title, corrupt artist_name, WITH a twin: DELETEs, raises no unique violation under cta_unique_null_track_idx', async () => {
    const libraryId = await seedLibrary(90005);
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', null, null);
    const corruptId = await seedCta(libraryId, 'Hermanos Guti�rrez', null, null);

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90005,
          track_position: null,
          current_artist_name: 'Hermanos Guti�rrez',
          current_track_title: null,
          true_artist_name: 'Hermanos Gutiérrez',
        },
      ])
    );

    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(0);
    const remaining = await sql`
      SELECT id FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${corruptId}
    `;
    expect(remaining).toHaveLength(0);
    const twin = await ctaRow(twinId);
    expect(twin.artist_name).toBe('Hermanos Gutiérrez');
    expect(twin.track_title).toBeNull();
    expect(await ctaCount(libraryId)).toBe(1);
  });

  test('NULL track_title, corrupt artist_name, WITHOUT a twin: UPDATEs, track_title stays NULL', async () => {
    const libraryId = await seedLibrary(90006);
    const corruptId = await seedCta(libraryId, 'Csillagrabl�k', null, null);

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90006,
          track_position: null,
          current_artist_name: 'Csillagrabl�k',
          current_track_title: null,
          true_artist_name: 'Csillagrablók',
        },
      ])
    );

    expect(result.deleted).toBe(0);
    expect(result.updated).toBe(1);
    const row = await ctaRow(corruptId);
    expect(row.artist_name).toBe('Csillagrablók');
    expect(row.track_title).toBeNull();
  });

  test('the U+FFFD predicate returns 0 across both columns after a run covering both corruption shapes', async () => {
    const libA = await seedLibrary(90007);
    await seedCta(libA, 'Csillagrablók', 'Rem�nytelen T�nc', '4');
    const libB = await seedLibrary(90008);
    await seedCta(libB, 'Csillagrabl�k', null, null);

    await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90007,
          track_position: '4',
          current_artist_name: 'Csillagrablók',
          current_track_title: 'Rem�nytelen T�nc',
          true_track_title: 'Reménytelen Tánc',
        },
        {
          legacy_release_id: 90008,
          track_position: null,
          current_artist_name: 'Csillagrabl�k',
          current_track_title: null,
          true_artist_name: 'Csillagrablók',
        },
      ])
    );

    const [{ remaining }] = await sql`
      SELECT COUNT(*)::int AS remaining
      FROM ${sql(TEST_SCHEMA)}.compilation_track_artist
      WHERE artist_name LIKE '%' || chr(65533) || '%' OR track_title LIKE '%' || chr(65533) || '%'
    `;
    expect(remaining).toBe(0);
  });

  test('a second run is a genuine no-op once the first has landed (twin + no-twin together)', async () => {
    const libA = await seedLibrary(90009);
    const twinId = await seedCta(libA, 'Hermanos Gutiérrez', 'Sonido Cósmico', '2');
    const deletedId = await seedCta(libA, 'Hermanos Gutiérrez', 'Sonido C�smico', '7');
    const libB = await seedLibrary(90010);
    const updatedId = await seedCta(libB, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

    const pending = [
      {
        legacy_release_id: 90009,
        track_position: '7',
        current_artist_name: 'Hermanos Gutiérrez',
        current_track_title: 'Sonido C�smico',
        true_track_title: 'Sonido Cósmico',
      },
      {
        legacy_release_id: 90010,
        track_position: '4',
        current_artist_name: 'Csillagrablók',
        current_track_title: 'Rem�nytelen T�nc',
        true_track_title: 'Reménytelen Tánc',
      },
    ];

    const first = await runRepairScript(withSyntheticPendingRows(pending));
    expect(first.deleted + first.updated).toBeGreaterThan(0);

    const second = await runRepairScript(withSyntheticPendingRows(pending));
    expect(second.deleted).toBe(0);
    expect(second.updated).toBe(0);

    // Values are still correct, not reverted or double-mangled.
    const twin = await ctaRow(twinId);
    expect(twin.track_title).toBe('Sonido Cósmico');
    const updated = await ctaRow(updatedId);
    expect(updated.track_title).toBe('Reménytelen Tánc');
    const stillDeleted = await sql`
      SELECT id FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${deletedId}
    `;
    expect(stillDeleted).toHaveLength(0);
  });

  test('is a no-op against an empty pending block (zero synthetic rows, mirroring the shipped state)', async () => {
    const libraryId = await seedLibrary(90011);
    const cleanId = await seedCta(libraryId, 'Jessica Pratt', 'Back, Baby', '1');

    const result = await runRepairScript(withSyntheticPendingRows([]));

    expect(result.deleted).toBe(0);
    expect(result.updated).toBe(0);
    expect(await ctaCount(libraryId)).toBe(1);
    const row = await ctaRow(cleanId);
    expect(row.artist_name).toBe('Jessica Pratt');
  });

  test('the guard-replacement-specified block rejects a pending row that fixes nothing', async () => {
    await seedLibrary(90012);
    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90012,
            track_position: '1',
            current_artist_name: 'Some Artist',
            current_track_title: 'Some Title',
            // both true_artist_name and true_track_title omitted -- nothing to fix
          },
        ])
      )
    ).rejects.toThrow(/BS#2152 guard/);
  });

  test('the guard-ambiguous-match block rejects a duplicate entry in the pending block', async () => {
    // Two live CTA rows sharing (library_id, artist_name, track_title) is
    // exactly what cta_unique_idx forbids in prod (and in this throwaway
    // schema, which replicates it) -- so a pending row can never genuinely
    // resolve to more than one live row. The guard's other purpose, an
    // accidental duplicate entry in the pending capture block itself
    // (the same real row pasted twice), is the reachable case: both
    // duplicate pending rows resolve to the SAME single live row, so
    // cta_repair_targets ends up with two rows sharing one identity, which
    // is what the guard actually detects.
    const libraryId = await seedLibrary(90013);
    await seedCta(libraryId, 'Csillagrabl�k', 'Duplicate Title', '1');

    const dupPendingRow = {
      legacy_release_id: 90013,
      track_position: '1',
      current_artist_name: 'Csillagrabl�k',
      current_track_title: 'Duplicate Title',
      true_artist_name: 'Csillagrablók',
    };

    await expect(runRepairScript(withSyntheticPendingRows([dupPendingRow, { ...dupPendingRow }]))).rejects.toThrow(
      /BS#2152 guard/
    );
  });

  // ==========================================================================
  // Required regression tests (PR #2154 review) -- the two HIGH findings.
  // ==========================================================================

  test('HIGH: a transposed capture (current/true swapped) aborts via guard-capture-sanity, BOTH rows survive intact', async () => {
    // Exact reviewer reproduction: seed ('Csillagrablók','Tánc') and
    // ('Csillagrablók','T<U+FFFD>nc'), then declare the pending row with
    // current/true swapped -- current_track_title holds the CLEAN string,
    // true_track_title holds the CORRUPT string. Unguarded, build-targets
    // would match the clean row (its current_* equals the declared
    // current_*), compute the corrupt string as the post-fix value, find the
    // genuinely corrupt row as its "twin", and DELETE the clean row.
    const libraryId = await seedLibrary(90015);
    const cleanId = await seedCta(libraryId, 'Csillagrablók', 'Tánc', '1');
    const corruptId = await seedCta(libraryId, 'Csillagrablók', 'T�nc', '2');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90015,
            track_position: '1',
            current_artist_name: 'Csillagrablók',
            current_track_title: 'Tánc', // TRANSPOSED: this is the CLEAN string
            true_track_title: 'T�nc', // TRANSPOSED: this is the CORRUPT string
          },
        ])
      )
    ).rejects.toThrow(/BS#2152 guard/);

    // Nothing was written -- the guard fires before BEGIN, and even if it
    // had fired inside the transaction, the ROLLBACK in runRepairScript's
    // catch block would undo it. Both rows survive with their original
    // values, byte for byte.
    const clean = await ctaRow(cleanId);
    expect(clean.track_title).toBe('Tánc');
    const corrupt = await ctaRow(corruptId);
    expect(corrupt.track_title).toBe('T�nc');
    expect(await ctaCount(libraryId)).toBe(2);
  });

  test('HIGH: two pending rows converging on the same post-fix tuple abort via guard-converging-pending, not a raw 23505', async () => {
    // Exact reviewer reproduction: two differently-corrupted copies of the
    // SAME real credit, with NO existing clean twin for either individually
    // -- ('Hermanos Guti<U+FFFD>rrez','Sonido Cósmico') and
    // ('Hermanos Gutiérrez','Sonido C<U+FFFD>smico'). Fixed independently,
    // both resolve to the identical (library_id, 'Hermanos Gutiérrez',
    // 'Sonido Cósmico') tuple -- has_twin=false for both (no live row holds
    // that tuple yet), so unguarded they'd both land in the single
    // update-no-twins UPDATE and collide under cta_unique_idx.
    const libraryId = await seedLibrary(90016);
    const rowAId = await seedCta(libraryId, 'Hermanos Guti�rrez', 'Sonido Cósmico', '1');
    const rowBId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '2');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90016,
            track_position: '1',
            current_artist_name: 'Hermanos Guti�rrez',
            current_track_title: 'Sonido Cósmico',
            true_artist_name: 'Hermanos Gutiérrez',
          },
          {
            legacy_release_id: 90016,
            track_position: '2',
            current_artist_name: 'Hermanos Gutiérrez',
            current_track_title: 'Sonido C�smico',
            true_track_title: 'Sonido Cósmico',
          },
        ])
      )
      // The named guard message, NOT a raw postgres 23505 unique-violation
      // error -- proves guard-converging-pending caught this before either
      // write statement ran, rather than the write failing safe by accident.
    ).rejects.toThrow(/BS#2152 guard/);

    // Both original corrupt rows survive untouched -- the transaction rolled
    // back before delete-twins/update-no-twins ever executed.
    const rowA = await ctaRow(rowAId);
    expect(rowA.artist_name).toBe('Hermanos Guti�rrez');
    expect(rowA.track_title).toBe('Sonido Cósmico');
    const rowB = await ctaRow(rowBId);
    expect(rowB.artist_name).toBe('Hermanos Gutiérrez');
    expect(rowB.track_title).toBe('Sonido C�smico');
    expect(await ctaCount(libraryId)).toBe(2);
  });

  // ==========================================================================
  // Additional coverage for the MEDIUM findings.
  // ==========================================================================

  test('MEDIUM: guard-placeholder-scrub rejects a captured row with a blank legacy_release_id (distinguishes it from the placeholder)', async () => {
    // Reviewer reproduction shape: a real captured row that lost its
    // legacy_release_id to a paste slip. Previously this was silently swept
    // by the same unconditional DELETE that scrubs the shipped placeholder,
    // and pending_declared undercounted with no warning.
    await seedLibrary(90017);
    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90017,
            track_position: '1',
            current_artist_name: 'Csillagrabl�k',
            current_track_title: null,
            true_artist_name: 'Csillagrablók',
          },
          {
            // Paste slip: every other column populated but legacy_release_id
            // blank -- must NOT be silently swept as if it were the shipped
            // all-NULL placeholder.
            legacy_release_id: null,
            track_position: '2',
            current_artist_name: 'Some Other Artist',
            current_track_title: 'Some Other Title',
            true_artist_name: 'Fixed Other Artist',
          },
        ])
      )
    ).rejects.toThrow(/BS#2152 guard/);
  });

  test("MEDIUM: the DELETE branch repoints the corrupt row's identity link + track_position onto the surviving twin before deleting it", async () => {
    // The corrupt row is the OLDER ingestion and is the one holding the
    // lml_backfill identity link; the clean twin has none yet. Reproduces
    // the review's repro shape (track_position='4', track_artist_id=4242) --
    // asserts the link survives onto the twin rather than being discarded
    // with the deleted row.
    const libraryId = await seedLibrary(90018);
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', null, {
      track_artist_id: null,
      track_artist_link_confidence: null,
      track_artist_link_method: null,
    });
    const corruptId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '4', {
      track_artist_id: 4242,
      track_artist_link_confidence: 0.93,
      track_artist_link_method: 'lml_backfill',
    });

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90018,
          track_position: '4',
          current_artist_name: 'Hermanos Gutiérrez',
          current_track_title: 'Sonido C�smico',
          true_track_title: 'Sonido Cósmico',
        },
      ])
    );

    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(0);
    const remaining = await sql`
      SELECT id FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${corruptId}
    `;
    expect(remaining).toHaveLength(0);

    const twin = await ctaRow(twinId);
    expect(twin.track_title).toBe('Sonido Cósmico');
    expect(twin.track_artist_id).toBe(4242);
    expect(twin.track_artist_link_confidence).toBeCloseTo(0.93);
    expect(twin.track_artist_link_method).toBe('lml_backfill');
    expect(twin.track_position).toBe('4'); // COALESCEd from the corrupt row (twin's own was NULL)
  });

  test('MEDIUM: the DELETE branch never overwrites a twin that already holds its OWN identity link', async () => {
    // The twin's own non-NULL values must win over the corrupt row's --
    // COALESCE(twin.*, corrupt.*), not the reverse.
    const libraryId = await seedLibrary(90019);
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '2', {
      track_artist_id: 1111,
      track_artist_link_confidence: 0.99,
      track_artist_link_method: 'librarian',
    });
    await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '4', {
      track_artist_id: 4242,
      track_artist_link_confidence: 0.5,
      track_artist_link_method: 'lml_backfill',
    });

    await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90019,
          track_position: '4',
          current_artist_name: 'Hermanos Gutiérrez',
          current_track_title: 'Sonido C�smico',
          true_track_title: 'Sonido Cósmico',
        },
      ])
    );

    const twin = await ctaRow(twinId);
    expect(twin.track_artist_id).toBe(1111);
    expect(twin.track_artist_link_confidence).toBeCloseTo(0.99);
    expect(twin.track_artist_link_method).toBe('librarian');
    expect(twin.track_position).toBe('2');
  });
});
