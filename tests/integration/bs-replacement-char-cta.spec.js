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
 * twin-aware DELETE/UPDATE branching, the idempotency guarantee, and the
 * NULL-track_title loophole (migration 0099 / `cta_unique_null_track_idx`)
 * are all exercised against the actual DDL/DML the operator will run --
 * only the pending DATA differs between this spec and prod.
 *
 * The throwaway `compilation_track_artist` table replicates BOTH production
 * unique indexes (`cta_unique_idx` and its NULL-track_title complement) --
 * unlike bs-replacement-char-phase4.spec.js's plain `text` columns, that
 * replication is load-bearing here: the whole point of the twin-aware design
 * is "never let a write hit a unique violation", and that claim is only
 * actually tested if the constraint exists to violate.
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
  'guard-replacement-specified',
  'build-targets',
  'guard-ambiguous-match',
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
 */
function extractStmtBlocks(scriptText, targetSchema) {
  const startRe = /^--\s*===\s*STMT:\s*([a-z-]+)\s*===\s*$/gm;
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

  beforeAll(async () => {
    sql = getTestDb();
    const scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8');
    blocks = extractStmtBlocks(scriptText, TEST_SCHEMA);

    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.library (
        id serial PRIMARY KEY,
        legacy_release_id integer UNIQUE NOT NULL
      )
    `);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.compilation_track_artist (
        id serial PRIMARY KEY,
        library_id integer NOT NULL,
        artist_name text NOT NULL,
        track_title text,
        track_position text
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
   * Run the script's actual mechanism (every block except the script's own
   * literal `insert-pending-rows`, which -- as shipped -- inserts nothing)
   * against whatever fixture rows the caller has already seeded, using
   * `pendingRows` as this run's captured-pairs block.
   *
   * `pending_cta_repair` and `cta_repair_targets` are TEMP TABLEs -- session
   * scoped, exactly like they are when an operator runs this script through
   * one `psql -f` connection. `getTestDb()` returns a POOL (max: 5), so
   * spreading these statements across ordinary pooled queries would create
   * the temp table on one physical connection and then fail to find it on
   * another. `sql.reserve()` pins one connection for the whole run, the same
   * single-session guarantee prod gets.
   */
  async function runRepairScript(pendingRows) {
    const reservedSql = await sql.reserve();
    try {
      await reservedSql.unsafe(blocks['create-pending-table']);
      if (pendingRows.length > 0) {
        // Unqualified, deliberately -- `pending_cta_repair` is a TEMP TABLE,
        // so it lives in this session's `pg_temp_N` schema, not
        // `TEST_SCHEMA`. Schema-qualifying it here would look identical to
        // qualifying an ordinary table and fail with "relation does not
        // exist" despite the table genuinely existing on this connection.
        //
        // `sql(array, ...columns)` generates the WHOLE `(columns…) VALUES
        // (…), (…)` fragment as one unit -- it is not just a values-list
        // helper. Writing an explicit column list before it (as a plain
        // `sql` tagged-template author would reasonably try first) silently
        // produces a mismatched column/value count ("INSERT has more target
        // columns than expressions"), because postgres-js then emits its
        // own column list a second time inside the substitution.
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
      await reservedSql.unsafe(blocks['guard-replacement-specified']);
      await reservedSql.unsafe(blocks['build-targets']);
      await reservedSql.unsafe(blocks['guard-ambiguous-match']);
      const deleteResult = await reservedSql.unsafe(blocks['delete-twins']);
      const updateResult = await reservedSql.unsafe(blocks['update-no-twins']);
      return { deleted: deleteResult.count, updated: updateResult.count };
    } finally {
      reservedSql.release();
    }
  }

  async function seedLibrary(legacyReleaseId) {
    const rows = await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id) VALUES (${legacyReleaseId})
      RETURNING id
    `;
    return rows[0].id;
  }

  async function seedCta(libraryId, artistName, trackTitle, trackPosition) {
    const rows = await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.compilation_track_artist (library_id, artist_name, track_title, track_position)
      VALUES (${libraryId}, ${artistName}, ${trackTitle}, ${trackPosition})
      RETURNING id
    `;
    return rows[0].id;
  }

  async function ctaRow(id) {
    const rows = await sql`
      SELECT artist_name, track_title FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${id}
    `;
    return rows[0];
  }

  async function ctaCount(libraryId) {
    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE library_id = ${libraryId}
    `;
    return rows[0].n;
  }

  test('extracts exactly the 8 expected STMT blocks, in order', () => {
    expect(Object.keys(blocks)).toEqual(EXPECTED_BLOCKS);
    for (const name of EXPECTED_BLOCKS) {
      expect(blocks[name].trim().length).toBeGreaterThan(0);
    }
  });

  test('corrupt track_title WITH a clean twin: DELETEs the corrupt row, raises no unique violation', async () => {
    const libraryId = await seedLibrary(90001);
    // The clean twin -- what the ETL's insert-only writer left behind
    // alongside the corrupt paste.
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '2');
    // The corrupt row: same artist, corrupted track_title, different position.
    const corruptId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '7');

    const result = await runRepairScript([
      {
        legacy_release_id: 90001,
        track_position: '7',
        current_artist_name: 'Hermanos Gutiérrez',
        current_track_title: 'Sonido C�smico',
        true_track_title: 'Sonido Cósmico',
      },
    ]);

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

    const result = await runRepairScript([
      {
        legacy_release_id: 90002,
        track_position: '4',
        current_artist_name: 'Csillagrablók',
        current_track_title: 'Rem�nytelen T�nc',
        true_track_title: 'Reménytelen Tánc',
      },
    ]);

    expect(result.deleted).toBe(0);
    expect(result.updated).toBe(1);
    const row = await ctaRow(corruptId);
    expect(row.artist_name).toBe('Csillagrablók');
    expect(row.track_title).toBe('Reménytelen Tánc');
  });

  test('a clean row not named in the pending block is left untouched', async () => {
    const libraryId = await seedLibrary(90003);
    const cleanId = await seedCta(libraryId, 'Chuquimamani-Condori', 'Call Your Name', '1');

    const result = await runRepairScript([]);

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

    await runRepairScript([
      {
        legacy_release_id: 90004,
        track_position: '4',
        current_artist_name: 'Csillagrablók',
        current_track_title: 'Rem�nytelen T�nc',
        true_track_title: 'Reménytelen Tánc',
      },
    ]);

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

    const result = await runRepairScript([
      {
        legacy_release_id: 90005,
        track_position: null,
        current_artist_name: 'Hermanos Guti�rrez',
        current_track_title: null,
        true_artist_name: 'Hermanos Gutiérrez',
      },
    ]);

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

    const result = await runRepairScript([
      {
        legacy_release_id: 90006,
        track_position: null,
        current_artist_name: 'Csillagrabl�k',
        current_track_title: null,
        true_artist_name: 'Csillagrablók',
      },
    ]);

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

    await runRepairScript([
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
    ]);

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

    const first = await runRepairScript(pending);
    expect(first.deleted + first.updated).toBeGreaterThan(0);

    const second = await runRepairScript(pending);
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

  test('is a no-op against an empty pending block (the script as shipped, pending prod capture)', async () => {
    const libraryId = await seedLibrary(90011);
    const cleanId = await seedCta(libraryId, 'Jessica Pratt', 'Back, Baby', '1');

    const result = await runRepairScript([]);

    expect(result.deleted).toBe(0);
    expect(result.updated).toBe(0);
    expect(await ctaCount(libraryId)).toBe(1);
    const row = await ctaRow(cleanId);
    expect(row.artist_name).toBe('Jessica Pratt');
  });

  test('the guard-replacement-specified block rejects a pending row that fixes nothing', async () => {
    await seedLibrary(90012);
    await expect(
      runRepairScript([
        {
          legacy_release_id: 90012,
          track_position: '1',
          current_artist_name: 'Some Artist',
          current_track_title: 'Some Title',
          // both true_artist_name and true_track_title omitted -- nothing to fix
        },
      ])
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
    await seedCta(libraryId, 'Duplicate Artist', 'Duplicate Title', '1');

    const dupPendingRow = {
      legacy_release_id: 90013,
      track_position: '1',
      current_artist_name: 'Duplicate Artist',
      current_track_title: 'Duplicate Title',
      true_artist_name: 'Fixed Artist',
    };

    await expect(runRepairScript([dupPendingRow, { ...dupPendingRow }])).rejects.toThrow(/BS#2152 guard/);
  });
});
