/**
 * BS#2117 — artist_crossreference backfill script.
 *
 * Postgres-backed (the BS analogue of the org `pg` marker): direct SQL, no
 * HTTP surface, since this exercises a hand-run operator script rather than
 * an API route.
 *
 * ZERO DRIFT. This spec does not re-type the script's SQL — it READS
 * scripts/audit/bs_2117_crossref_backfill.sql and executes the parts that
 * carry the logic verbatim:
 *
 *   1. `pg_temp.bs2117_resolve_artist()`, the three-stage resolver
 *      (folded name -> code_letters -> genre_artist_crossreference code).
 *   2. `bs2117_provenance_conflicts`, the 15-row exclusion list.
 *   3. The transactional INSERT: resolve -> self-pair guard ->
 *      provenance-conflict guard -> LEAST/GREATEST canonicalization ->
 *      DISTINCT ON dedup -> either-direction NOT EXISTS ->
 *      ON CONFLICT DO NOTHING.
 *
 * `extractInsert` additionally asserts each of those guards is PRESENT in what
 * it sliced out, so deleting one from the script fails this spec loudly rather
 * than quietly shrinking its coverage.
 *
 * Editing either one changes what this spec runs. That is the same convention
 * tests/integration/relabel-rotation-direct-backfill.spec.js uses, including
 * its `wxyc_schema.` -> throwaway-schema rewrite.
 *
 * That rewrite is also what makes running the real SQL safe here. The script's
 * embedded 110-pair dataset is real tubafrenzy artist names, several of which
 * ("Sankofa", "Oliver Lake", ...) exist as real rows in the prod-clone fixture
 * some local databases load (dev_env/seed-clone.sql). Redirecting every table
 * reference into `bs2117_backfill_test` means the resolver can only ever see
 * the synthetic artists this spec creates and reaps, so the outcome does not
 * depend on LOAD_CLONE_FIXTURE and no real catalog row is touched. The pairs
 * this spec feeds in are chosen shapes, not the file's 110-row payload — that
 * payload is data, and the operator's pre-amble is what audits it.
 *
 * Temp objects (`bs2117_pairs`, the resolver function) are session-scoped, so
 * everything runs on ONE reserved connection. The shared pool is `max: 5`;
 * without the reservation a later statement can land on a different backend
 * and fail with `relation "bs2117_pairs" does not exist`.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'audit', 'bs_2117_crossref_backfill.sql');
const TEST_SCHEMA = 'bs2117_backfill_test';

// Synthetic artists. Ids are arbitrary — they live in a throwaway schema that
// is dropped wholesale in afterAll, so they cannot collide with anything.
const ART_ALPHA = 1;
const ART_BETA = 2;
const ART_GAMMA = 3; // unrelated third artist
const ART_SELF = 4; // single artist both sides of a pair resolve to
const ART_LAKE_JAZZ = 5; // 'BS2117 Lake', code ZL, genre code 17
const ART_LAKE_ROCK = 6; // 'BS2117 Lake', code ZL, genre code 2  (row-128 shape)
const ART_TWIN_A = 7; // 'BS2117 Twin', code ZT, genre code 50
const ART_TWIN_B = 8; // 'BS2117 Twin', code ZT, genre code 50  (ambiguous shape)

const ALPHA_NAME = 'BS2117 Xref Alpha';
const BETA_NAME = 'BS2117 Xref Beta';
const GAMMA_NAME = 'BS2117 Xref Gamma';
const SELF_NAME = 'BS2117 Xref Self';
const LAKE_NAME = 'BS2117 Lake';
const TWIN_NAME = 'BS2117 Twin';

/**
 * Pull the resolver function definition out of the operator script.
 * Spans `CREATE OR REPLACE FUNCTION pg_temp.bs2117_resolve_artist` through the
 * `$$ LANGUAGE plpgsql STABLE;` that closes it.
 */
function extractResolver(scriptText) {
  const start = scriptText.indexOf('CREATE OR REPLACE FUNCTION pg_temp.bs2117_resolve_artist');
  if (start === -1) {
    throw new Error('bs2117_resolve_artist definition not found in the backfill script');
  }
  const endMarker = '$$ LANGUAGE plpgsql STABLE;';
  const end = scriptText.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error('bs2117_resolve_artist definition is not terminated by "$$ LANGUAGE plpgsql STABLE;"');
  }
  return scriptText.slice(start, end + endMarker.length);
}

/**
 * Pull the `CREATE TEMP TABLE bs2117_pairs (...)` definition, so the pair
 * table this spec feeds has exactly the column shape the INSERT reads.
 */
function extractPairTableDdl(scriptText) {
  const start = scriptText.indexOf('CREATE TEMP TABLE bs2117_pairs');
  if (start === -1) {
    throw new Error('bs2117_pairs table definition not found in the backfill script');
  }
  const end = scriptText.indexOf(';', scriptText.indexOf('ON COMMIT PRESERVE ROWS', start));
  if (end === -1) {
    throw new Error('bs2117_pairs table definition is not terminated');
  }
  return scriptText.slice(start, end + 1);
}

/**
 * Pull the single transactional INSERT. Located by its target table, then
 * walked back to the `WITH resolved AS (` that opens it — the file contains
 * three other CTEs by that name (two pre-amble, one post-amble) and only this
 * one writes.
 */
function extractInsert(scriptText) {
  const insertAt = scriptText.indexOf('INSERT INTO wxyc_schema.artist_crossreference');
  if (insertAt === -1) {
    throw new Error('the artist_crossreference INSERT was not found in the backfill script');
  }
  const start = scriptText.lastIndexOf('WITH resolved AS (', insertAt);
  if (start === -1) {
    throw new Error('the INSERT is not preceded by its `WITH resolved AS (` CTE');
  }
  const endMarker = 'ON CONFLICT (source_artist_id, target_artist_id) DO NOTHING;';
  const end = scriptText.indexOf(endMarker, insertAt);
  if (end === -1) {
    throw new Error('the INSERT does not end in the expected ON CONFLICT clause');
  }
  const extracted = scriptText.slice(start, end + endMarker.length);

  // The slicing above is by string index, so a reformat of the script could
  // silently hand back a fragment that still parses but has lost a guard —
  // and every assertion below would keep passing against the weaker SQL.
  // Assert the invariants are present in what we actually extracted, so a
  // mis-slice (or a guard deleted from the script outright) fails loudly here
  // rather than quietly reducing this spec's coverage.
  const required = [
    ['self-pair guard', 'src.artist_id <> tgt.artist_id'],
    ['LEAST canonicalization', 'LEAST(source_artist_id, target_artist_id)'],
    ['GREATEST canonicalization', 'GREATEST(source_artist_id, target_artist_id)'],
    ['dedup', 'DISTINCT ON (source_artist_id, target_artist_id)'],
    ['either-direction guard', 'NOT EXISTS'],
    ['provenance-conflict guard', 'bs2117_provenance_conflicts'],
  ];
  for (const [label, needle] of required) {
    if (!extracted.includes(needle)) {
      throw new Error(
        `extracted INSERT is missing its ${label} (${needle}) — the script changed shape, or the extraction mis-sliced`
      );
    }
  }
  return extracted;
}

/**
 * Pull the `bs2117_provenance_conflicts` scratch table (DDL + its VALUES), the
 * exclusion list the INSERT joins against. Extracted rather than re-typed so
 * the spec exercises the real 15 excluded row_ids.
 */
function extractConflictsSetup(scriptText) {
  const start = scriptText.indexOf('CREATE TEMP TABLE bs2117_provenance_conflicts');
  if (start === -1) {
    throw new Error('bs2117_provenance_conflicts table definition not found in the backfill script');
  }
  const insertAt = scriptText.indexOf('INSERT INTO bs2117_provenance_conflicts', start);
  if (insertAt === -1) {
    throw new Error('bs2117_provenance_conflicts is declared but never populated');
  }
  const end = scriptText.indexOf(';', scriptText.indexOf("'Golden Palominos')", insertAt));
  if (end === -1) {
    throw new Error('the bs2117_provenance_conflicts VALUES list is not terminated');
  }
  return scriptText.slice(start, end + 1);
}

/** Redirect every `wxyc_schema.` reference at the throwaway test schema. */
function retarget(sqlText) {
  return sqlText.replace(/wxyc_schema\./g, `${TEST_SCHEMA}.`);
}

describe('BS#2117 artist_crossreference backfill (real PG, real script SQL)', () => {
  let pool;
  let sql; // reserved single connection — temp objects live here
  let backfillInsert;

  beforeAll(async () => {
    pool = getTestDb();
    sql = await pool.reserve();

    const scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const resolverDdl = retarget(extractResolver(scriptText));
    const pairTableDdl = extractPairTableDdl(scriptText);
    const conflictsSetup = extractConflictsSetup(scriptText);
    backfillInsert = retarget(extractInsert(scriptText));

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${TEST_SCHEMA}`);

    // The resolver calls `<schema>.fold_artist_name`. Delegate to the real one
    // rather than copying its body, so the spec cannot drift from migration
    // 0134's actual folding rule.
    await sql.unsafe(`
      CREATE FUNCTION ${TEST_SCHEMA}.fold_artist_name(input text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $fold$ SELECT wxyc_schema.fold_artist_name(input) $fold$
    `);

    // Mirror the real column shapes the script depends on: code_letters
    // NOT NULL (why an empty CALL_LETTERS can never match), and the ORDERED
    // unique index that makes ON CONFLICT's conflict target valid while
    // leaving the reversed pair for the NOT EXISTS guard to catch.
    await sql.unsafe(`
      CREATE TABLE ${TEST_SCHEMA}.artists (
        id integer PRIMARY KEY,
        artist_name varchar(128) NOT NULL,
        code_letters varchar(4) NOT NULL
      )
    `);
    await sql.unsafe(`
      CREATE TABLE ${TEST_SCHEMA}.genre_artist_crossreference (
        artist_id integer NOT NULL REFERENCES ${TEST_SCHEMA}.artists(id),
        genre_id integer NOT NULL,
        artist_genre_code integer NOT NULL
      )
    `);
    await sql.unsafe(`
      CREATE TABLE ${TEST_SCHEMA}.artist_crossreference (
        source_artist_id integer NOT NULL REFERENCES ${TEST_SCHEMA}.artists(id),
        target_artist_id integer NOT NULL REFERENCES ${TEST_SCHEMA}.artists(id),
        comment varchar(255)
      )
    `);
    await sql.unsafe(`
      CREATE UNIQUE INDEX artist_crossref_source_target
        ON ${TEST_SCHEMA}.artist_crossreference (source_artist_id, target_artist_id)
    `);

    await sql.unsafe(`
      INSERT INTO ${TEST_SCHEMA}.artists (id, artist_name, code_letters) VALUES
        (${ART_ALPHA}, '${ALPHA_NAME}', 'ZA'),
        (${ART_BETA}, '${BETA_NAME}', 'ZB'),
        (${ART_GAMMA}, '${GAMMA_NAME}', 'ZC'),
        (${ART_SELF}, '${SELF_NAME}', 'ZD'),
        (${ART_LAKE_JAZZ}, '${LAKE_NAME}', 'ZL'),
        (${ART_LAKE_ROCK}, '${LAKE_NAME}', 'ZL'),
        (${ART_TWIN_A}, '${TWIN_NAME}', 'ZT'),
        (${ART_TWIN_B}, '${TWIN_NAME}', 'ZT')
    `);
    await sql.unsafe(`
      INSERT INTO ${TEST_SCHEMA}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code) VALUES
        (${ART_LAKE_JAZZ}, 7, 17),
        (${ART_LAKE_ROCK}, 13, 2),
        (${ART_TWIN_A}, 6, 50),
        (${ART_TWIN_B}, 6, 50)
    `);

    await sql.unsafe(resolverDdl);
    await sql.unsafe(pairTableDdl);
    await sql.unsafe(conflictsSetup);
  });

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${TEST_SCHEMA}.artist_crossreference`);
    await sql.unsafe('TRUNCATE bs2117_pairs');
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      // Temp objects die with the session; releasing returns the backend to
      // the shared pool, which the rest of the suite still needs open.
      sql.release();
    }
  });

  /** Load pairs into the script's own temp table, then run the script's INSERT. */
  async function runBackfill(pairs, firstRowId = 900) {
    // Default row ids start well clear of the real LIBRARY_CODE_CROSS_REFERENCE
    // ids, so a fixture pair never collides with the excluded-conflict list
    // unless a test asks for it explicitly.
    let rowId = firstRowId;
    for (const p of pairs) {
      await sql.unsafe(
        `INSERT INTO bs2117_pairs
           (row_id, src_name, src_letters, src_number, tgt_name, tgt_letters, tgt_number, xref_comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          rowId++,
          p.srcName,
          p.srcLetters,
          p.srcNumber ?? 0,
          p.tgtName,
          p.tgtLetters,
          p.tgtNumber ?? 0,
          p.comment ?? null,
        ]
      );
    }
    await sql.unsafe(backfillInsert);
  }

  const pair = (srcName, srcLetters, tgtName, tgtLetters, extra = {}) => ({
    srcName,
    srcLetters,
    tgtName,
    tgtLetters,
    ...extra,
  });

  async function crossRefsBetween(a, b) {
    return sql.unsafe(
      `SELECT source_artist_id, target_artist_id, comment
         FROM ${TEST_SCHEMA}.artist_crossreference
        WHERE (source_artist_id = $1 AND target_artist_id = $2)
           OR (source_artist_id = $2 AND target_artist_id = $1)`,
      [a, b]
    );
  }

  test('inserts exactly one row for a resolvable pair, carrying the cataloger comment', async () => {
    await runBackfill([pair(ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', { comment: 'shared member (test)' })]);

    const rows = await crossRefsBetween(ART_ALPHA, ART_BETA);
    expect(rows).toHaveLength(1);
    expect(rows[0].comment).toBe('shared member (test)');
  });

  test('re-running the same pair is a no-op (idempotent)', async () => {
    await runBackfill([pair(ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', { comment: 'shared member (test)' })]);
    await sql.unsafe(backfillInsert); // second run, same loaded pairs

    expect(await crossRefsBetween(ART_ALPHA, ART_BETA)).toHaveLength(1);
  });

  test('the reversed-direction duplicate collapses to one row, not two', async () => {
    // Mirrors LIBRARY_CODE_CROSS_REFERENCE ids 74/75 (Sankofa <-> The Apple
    // Juice Kid), recorded in both directions in the real tubafrenzy source.
    // The ordered unique index cannot catch this; LEAST/GREATEST is what does.
    await runBackfill([pair(ALPHA_NAME, 'ZA', BETA_NAME, 'ZB'), pair(BETA_NAME, 'ZB', ALPHA_NAME, 'ZA')]);

    expect(await crossRefsBetween(ART_ALPHA, ART_BETA)).toHaveLength(1);
  });

  test('a pair Backend already holds in the OPPOSITE direction is not duplicated', async () => {
    // The prod case: a non-empty starting table. ON CONFLICT on the ordered
    // pair would miss this; the either-direction NOT EXISTS is what catches it.
    await sql.unsafe(
      `INSERT INTO ${TEST_SCHEMA}.artist_crossreference (source_artist_id, target_artist_id, comment)
       VALUES ($1, $2, 'pre-existing')`,
      [ART_BETA, ART_ALPHA]
    );

    await runBackfill([pair(ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', { comment: 'would-be-new' })]);

    const rows = await crossRefsBetween(ART_ALPHA, ART_BETA);
    expect(rows).toHaveLength(1);
    expect(rows[0].comment).toBe('pre-existing'); // untouched, not overwritten
  });

  test('a true self-pair (both sides resolve to one artist) is never inserted', async () => {
    await runBackfill([pair(SELF_NAME, 'ZD', SELF_NAME, 'ZD', { comment: 'same artist (test)' })]);

    const rows = await sql.unsafe(
      `SELECT * FROM ${TEST_SCHEMA}.artist_crossreference
        WHERE source_artist_id = $1 OR target_artist_id = $1`,
      [ART_SELF]
    );
    expect(rows).toHaveLength(0);
  });

  test('two same-named artists split by genre code resolve to DIFFERENT ids and are linked', async () => {
    // The real row 128 shape ("Oliver Lake" -> "Oliver Lake", CALL_NUMBERS 17
    // vs 2). Both sides share a name AND code_letters, so only stage 3 can
    // separate them. This must NOT be swallowed by the self-pair guard: the
    // two tubafrenzy LIBRARY_CODEs are two real Backend artists, and the
    // cross-reference between them is exactly the alias parity expects.
    await runBackfill([
      pair(LAKE_NAME, 'ZL', LAKE_NAME, 'ZL', { srcNumber: 17, tgtNumber: 2, comment: 'same artist, two filings' }),
    ]);

    const rows = await crossRefsBetween(ART_LAKE_JAZZ, ART_LAKE_ROCK);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_artist_id).toBe(Math.min(ART_LAKE_JAZZ, ART_LAKE_ROCK));
    expect(rows[0].target_artist_id).toBe(Math.max(ART_LAKE_JAZZ, ART_LAKE_ROCK));
  });

  test('a name that stays ambiguous after all three stages is skipped, not guessed', async () => {
    // Two artists, same folded name, same code_letters, same genre code —
    // nothing left to disambiguate on. The resolver must report rather than
    // pick one, so nothing is inserted for either candidate.
    await runBackfill([pair(TWIN_NAME, 'ZT', ALPHA_NAME, 'ZA', { srcNumber: 50 })]);

    const rows = await sql.unsafe(
      `SELECT * FROM ${TEST_SCHEMA}.artist_crossreference
        WHERE source_artist_id IN ($1, $2) OR target_artist_id IN ($1, $2)`,
      [ART_TWIN_A, ART_TWIN_B]
    );
    expect(rows).toHaveLength(0);
  });

  test('a pair on the provenance-conflict list is excluded even when fully resolvable', async () => {
    // row_id 26 is one of the 15 whose referencing side tubafrenzy's own
    // COMMENT contradicts ("Cactus World News" where the note says Tonya
    // Donelly). Both endpoints resolve here, so ONLY the exclusion list can
    // keep it out — if that guard regresses, this inserts a false alias.
    await runBackfill([pair(ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', { comment: 'would-be-false-alias' })], 26);

    expect(await crossRefsBetween(ART_ALPHA, ART_BETA)).toHaveLength(0);
  });

  test('an unresolvable name (no matching artist) inserts nothing and does not throw', async () => {
    // The 31-pair ceiling: a tubafrenzy "pointer" name with no Backend artist.
    await expect(runBackfill([pair('BS2117 Nonexistent Pointer Artist', '', BETA_NAME, 'ZB')])).resolves.not.toThrow();

    const rows = await sql.unsafe(`SELECT * FROM ${TEST_SCHEMA}.artist_crossreference WHERE target_artist_id = $1`, [
      ART_BETA,
    ]);
    expect(rows).toHaveLength(0);
  });

  test('an unrelated third artist is unaffected', async () => {
    await runBackfill([pair(ALPHA_NAME, 'ZA', BETA_NAME, 'ZB')]);

    const rows = await sql.unsafe(
      `SELECT * FROM ${TEST_SCHEMA}.artist_crossreference
        WHERE source_artist_id = $1 OR target_artist_id = $1`,
      [ART_GAMMA]
    );
    expect(rows).toHaveLength(0);
  });

  test('the catalog export artist_aliases CTE emits the alias in both directions once inserted', async () => {
    // Mirrors the artist_aliases CTE in apps/backend/services/catalog-export.service.ts:
    // UNION both FK directions so a row filed under either endpoint surfaces the
    // other — which is why one row in one direction is enough.
    await runBackfill([pair(ALPHA_NAME, 'ZA', BETA_NAME, 'ZB')]);

    const aliasRows = await sql.unsafe(
      `
      WITH artist_aliases AS (
        SELECT cp.artist_id, array_agg(DISTINCT a.artist_name) AS cross_reference_names
        FROM (
          SELECT source_artist_id AS artist_id, target_artist_id AS other_id
          FROM ${TEST_SCHEMA}.artist_crossreference
          UNION
          SELECT target_artist_id AS artist_id, source_artist_id AS other_id
          FROM ${TEST_SCHEMA}.artist_crossreference
        ) cp
        JOIN ${TEST_SCHEMA}.artists a ON a.id = cp.other_id
        WHERE cp.other_id <> cp.artist_id
        GROUP BY cp.artist_id
      )
      SELECT artist_id, cross_reference_names FROM artist_aliases
      WHERE artist_id IN ($1, $2)
      ORDER BY artist_id
    `,
      [ART_ALPHA, ART_BETA]
    );

    const byId = new Map(aliasRows.map((r) => [r.artist_id, r.cross_reference_names]));
    expect(byId.get(ART_ALPHA)).toEqual([BETA_NAME]);
    expect(byId.get(ART_BETA)).toEqual([ALPHA_NAME]);
  });
});
