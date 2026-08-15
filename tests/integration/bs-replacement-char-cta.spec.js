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
 * "The actual DDL/DML" is meant literally as of round 3. Through round 2 the
 * script's read-only pre-amble and its post-amble residual reads carried no
 * STMT tags, so this spec only pinned their POSITION in the file with
 * `indexOf` and never executed a line of them -- a typo in the post-amble
 * would have passed the whole suite and then aborted the real prod run under
 * ON_ERROR_STOP after the writes and before COMMIT, rolling back a repair
 * that had succeeded. They are tagged blocks now and `runRepairScript` runs
 * them, along with the `SET LOCAL statement_timeout` lines and the
 * `lock-targets` row locks, in the exact order `psql -f` would.
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
 *
 * Round 4 adds coverage for the Unicode-composition-form defect: the twin
 * join, and the delete-twins/repoint-twin-identity re-checks that mirror it,
 * now compare `normalize(x, NFC)` rather than raw bytes, so a genuinely
 * NFD-stored live twin is FOUND instead of silently missed (see the script's
 * own header and build-targets' own comment for the full failure mode). The
 * "round 4" tests below pin the specific scenario that motivated the fix
 * (an NFD twin now takes the DELETE branch and leaves exactly one row) plus
 * the new `guard-post-write-nfc-duplicate` belt-and-braces check.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

// PostgreSQL dollar-quote delimiters: `$$` or `$tag$`, where tag follows
// identifier rules -- leading letter/underscore, then letters, DIGITS, or
// underscores. The digits are the part round 5 found missing: the previous
// `/\$[A-Za-z_]*\$/` could not match `$q1$` or `$tag1$`.
const DOLLAR_QUOTE_PATTERN = /\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/;

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
  'guard-nfc-form',
  'pending-match-preview',
  'guard-unknown-release',
  'before-residual',
  'build-targets',
  'lock-targets',
  'guard-post-fix-fffd',
  'guard-ambiguous-match',
  'guard-converging-pending',
  'before-matched-rows',
  'repoint-twin-identity',
  'delete-twins',
  'update-no-twins',
  'guard-repair-complete',
  'guard-post-write-nfc-duplicate',
  'post-amble-residual',
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
    const body = scriptText.slice(contentStart, endMatch.index);
    // A MISSING end marker throws loudly above; a TYPO'd one used to be
    // silent, and silently much worse (PR #2154 review round 3). `endRe.exec`
    // simply scans on to the NEXT end marker in the file, so block N absorbs
    // block N+1's SQL -- the intervening `-- === STMT: ... ===` line is an
    // inert SQL comment, so it executes without complaint. Block N+1 still
    // extracts separately from its own start marker, so its statements then
    // run TWICE per pass, and `.count` on a now multi-statement `unsafe()` no
    // longer means "rows this statement affected". Neither the non-empty
    // check nor the indexOf-based ordering tests notice: the block names and
    // their order are still exactly right. The spec would be validating a
    // different execution shape than the operator's `psql -f` run, which is
    // the one thing this whole extractor exists to prevent.
    if (startRe.test(body)) {
      startRe.lastIndex = 0;
      throw new Error(
        `STMT block "${name}" swallowed a nested "-- === STMT: ... ===" start marker -- its own "-- === END STMT ===" is missing or misspelled, so it absorbed the following block`
      );
    }
    startRe.lastIndex = 0;
    blocks[name] = body.replace(/wxyc_schema\./g, `${targetSchema}.`);
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
  // Rows the `before-matched-rows` operator print emitted on the most recent
  // run, so a test can assert on what the OPERATOR actually sees rather than
  // re-deriving it from cta_repair_targets (which outlives neither the
  // transaction nor a guard abort).
  let lastBeforeMatchedRows = [];

  async function runRepairScript(insertPhase, hooks = {}) {
    const reservedSql = await sql.reserve();
    let inTransaction = false;
    lastBeforeMatchedRows = [];
    try {
      await reservedSql.unsafe(blocks['create-pending-table']);
      await insertPhase(reservedSql);
      await reservedSql.unsafe(blocks['guard-placeholder-scrub']);
      await reservedSql.unsafe(blocks['guard-replacement-specified']);
      await reservedSql.unsafe(blocks['guard-capture-sanity']);
      await reservedSql.unsafe(blocks['guard-nfc-form']);
      await reservedSql.unsafe(blocks['pending-match-preview']);
      await reservedSql.unsafe(blocks['guard-unknown-release']);
      await reservedSql.unsafe(blocks['before-residual']);

      await reservedSql.unsafe('BEGIN');
      inTransaction = true;
      await reservedSql.unsafe("SET LOCAL statement_timeout = '30s'");
      await reservedSql.unsafe(blocks['build-targets']);
      // The one window `lock-targets` cannot close is the one in front of
      // it. Tests that need to land a concurrent write inside that window
      // inject it here rather than hand-copying this sequence (PR #2154
      // review round 3) -- a copy drifts from the real 20-block order, and
      // more importantly a copy that lacks this function's catch/ROLLBACK
      // hands an aborted-transaction connection back to the shared max:5
      // pool, where postgres-js's `release()` issues no ROLLBACK or DISCARD
      // of its own. The next query to draw that connection -- including
      // afterAll's DROP SCHEMA, under --runInBand -- then fails with
      // "current transaction is aborted", masking whatever actually broke.
      if (hooks.afterBuildTargets) {
        await hooks.afterBuildTargets(reservedSql);
      }
      await reservedSql.unsafe(blocks['lock-targets']);
      await reservedSql.unsafe(blocks['guard-post-fix-fffd']);
      await reservedSql.unsafe(blocks['guard-ambiguous-match']);
      await reservedSql.unsafe(blocks['guard-converging-pending']);
      if (hooks.afterGuards) {
        await hooks.afterGuards(reservedSql);
      }
      // The operator-facing BEFORE print. Executed here, in its real
      // position, because through round 4 it was untagged and therefore
      // unexecuted -- a column typo in it passed the whole suite and then
      // aborted the real prod run under ON_ERROR_STOP (round 5 finding).
      // Two statements (the section label, then the projection), so
      // postgres-js returns one result array per statement -- the rows are
      // the SECOND. Verified against the driver rather than assumed:
      // `[[{section}], [ ...rows ]]`.
      const beforeMatched = await reservedSql.unsafe(blocks['before-matched-rows']);
      lastBeforeMatchedRows = beforeMatched.length === 2 ? beforeMatched[1] : beforeMatched;
      await reservedSql.unsafe(blocks['repoint-twin-identity']);
      const deleteResult = await reservedSql.unsafe(blocks['delete-twins']);
      const updateResult = await reservedSql.unsafe(blocks['update-no-twins']);
      await reservedSql.unsafe(blocks['guard-repair-complete']);
      await reservedSql.unsafe(blocks['guard-post-write-nfc-duplicate']);
      await reservedSql.unsafe("SET LOCAL statement_timeout = '5min'");
      await reservedSql.unsafe(blocks['post-amble-residual']);
      await reservedSql.unsafe('COMMIT');
      inTransaction = false;

      await reservedSql.unsafe(blocks['analyze']);
      return { deleted: deleteResult.count, updated: updateResult.count, beforeMatched: lastBeforeMatchedRows };
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

  test('extracts exactly the 22 expected STMT blocks, in order', () => {
    expect(Object.keys(blocks)).toEqual(EXPECTED_BLOCKS);
    for (const name of EXPECTED_BLOCKS) {
      expect(blocks[name].trim().length).toBeGreaterThan(0);
    }
  });

  test("extractStmtBlocks refuses a block that swallowed the next one (round 3: a TYPO'd END marker, unlike a missing one, used to be silent -- the block absorbs its successor's SQL and that successor then executes twice per run, with every name/order assertion still green)", () => {
    const sabotaged = scriptText.replace('-- === END STMT ===', '-- === END STMTT ===');
    expect(sabotaged).not.toBe(scriptText);
    expect(() => extractStmtBlocks(sabotaged, TEST_SCHEMA)).toThrow('swallowed a nested');
  });

  test('the transaction boundary is positioned correctly: BEGIN; precedes build-targets, COMMIT; precedes the final ANALYZE (MEDIUM finding, PR #2154 review round 2 -- a prior version of this test only asserted BEGIN;/COMMIT; existed SOMEWHERE in the file, which cannot detect either boundary moving to the wrong side of a STMT block; verified against the review-cited regression: a verbatim revert of round 1\'s "classify inside the transaction" fix, or moving ANALYZE inside the transaction, both left the old assertion-only-existence version of this test green)', () => {
    const beginIdx = scriptText.indexOf('\nBEGIN;\n');
    const buildTargetsIdx = scriptText.indexOf('-- === STMT: build-targets ===');
    const commitIdx = scriptText.indexOf('\nCOMMIT;\n');
    const analyzeStmtIdx = scriptText.indexOf('-- === STMT: analyze ===');
    const analyzeSqlIdx = scriptText.indexOf('ANALYZE wxyc_schema.compilation_track_artist;');

    expect(beginIdx).toBeGreaterThan(-1);
    expect(buildTargetsIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(analyzeStmtIdx).toBeGreaterThan(-1);
    expect(analyzeSqlIdx).toBeGreaterThan(-1);

    expect(beginIdx).toBeLessThan(buildTargetsIdx);
    expect(commitIdx).toBeGreaterThan(buildTargetsIdx);
    expect(commitIdx).toBeLessThan(analyzeStmtIdx);
    expect(commitIdx).toBeLessThan(analyzeSqlIdx);
  });

  test('the post-amble residual-count reads sit BEFORE COMMIT;, not after (MEDIUM finding, PR #2154 review round 2 -- pins the fix for the broken "swap COMMIT; for ROLLBACK;" dry-run recipe the header documents: with these reads after COMMIT;, a ROLLBACK undoes the CREATE TEMP TABLE cta_repair_targets they depend on and the whole script aborts)', () => {
    const updateNoTwinsEndIdx = scriptText.indexOf(
      '-- === END STMT ===',
      scriptText.indexOf('-- === STMT: update-no-twins ===')
    );
    const postAmbleIdx = scriptText.indexOf('post-amble: residual count per targeted row');
    const commitIdx = scriptText.indexOf('\nCOMMIT;\n');

    expect(updateNoTwinsEndIdx).toBeGreaterThan(-1);
    expect(postAmbleIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);

    expect(postAmbleIdx).toBeGreaterThan(updateNoTwinsEndIdx);
    expect(postAmbleIdx).toBeLessThan(commitIdx);
  });

  test('the statement_timeout is raised ONLY after the last write, so a slow residual scan cannot roll back a repair that already succeeded -- and the 30s cap still covers every writing statement (round 3 finding)', () => {
    // The AFTER residual counts are two unindexable full-table scans by
    // construction (1-character leading-wildcard LIKE; the pg_trgm GIN indexes
    // extract zero trigrams from one character), and they run INSIDE the write
    // transaction because the dry-run recipe requires it. Under the flat 30s
    // cap, a cold cache or I/O contention from the concurrent 30-minute
    // library-etl cycle times the scan out, ON_ERROR_STOP aborts, COMMIT is
    // never reached -- and a fully correct 14-row repair is destroyed to fail
    // a verification read.
    //
    // `SET LOCAL` is last-write-wins within the transaction, so the ORDER is
    // the entire fix: raised after the writes, the 30s bound still governs
    // every statement that writes (including the lock wait in lock-targets,
    // where timing out is the DESIRED behavior -- abort rather than park
    // behind a concurrent writer). Raised any earlier and that bound is gone.
    const beginIdx = scriptText.indexOf('\nBEGIN;\n');
    const writeCapIdx = scriptText.indexOf("SET LOCAL statement_timeout = '30s';");
    const lastWriteEndIdx = scriptText.indexOf(
      '-- === END STMT ===',
      scriptText.indexOf('-- === STMT: update-no-twins ===')
    );
    const raisedCapIdx = scriptText.indexOf("SET LOCAL statement_timeout = '5min';");
    const postAmbleIdx = scriptText.indexOf('-- === STMT: post-amble-residual ===');
    const commitIdx = scriptText.indexOf('\nCOMMIT;\n');

    expect(writeCapIdx).toBeGreaterThan(-1);
    expect(raisedCapIdx).toBeGreaterThan(-1);
    expect(postAmbleIdx).toBeGreaterThan(-1);

    expect(writeCapIdx).toBeGreaterThan(beginIdx);
    expect(writeCapIdx).toBeLessThan(lastWriteEndIdx);
    expect(raisedCapIdx).toBeGreaterThan(lastWriteEndIdx);
    expect(raisedCapIdx).toBeLessThan(postAmbleIdx);
    expect(postAmbleIdx).toBeLessThan(commitIdx);
  });

  test('the shipped insert-pending-rows block carries no quoted string literals in its SQL -- i.e. it is still just the all-NULL placeholder (the missing enforcement gate, PR #2154 review round 2)', () => {
    // The deferred byte-exact codepoint assertion (Phase 4's
    // scriptUsesTheRightCodepoints analogue, see the header's "Known gap,
    // deliberately deferred" note) can't be written until an operator has
    // actually captured and pasted the 14 real rows. The INVERSE is
    // checkable today: as long as the shipped VALUES list is still just the
    // placeholder, that gap is inert. Every real captured row has at least
    // one single-quoted string (an artist_name or track_title); the
    // placeholder and its scrub DELETE have none. This goes red the moment
    // real data lands, forcing whoever adds it to add the codepoint
    // assertion in the SAME change (see the header note this test is
    // pointed at).
    const sqlOnly = blocks['insert-pending-rows']
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(sqlOnly).not.toMatch(/'/);
    // Dollar quoting is the hole the single-quote check alone leaves open
    // (round 3 finding). `$$Csillagrablók$$` and `$t$Reménytelen Tánc$t$` are
    // both valid PostgreSQL string literals containing zero apostrophes, and
    // they are exactly what an operator (or an agent) reaches for to avoid
    // escaping the apostrophes real track titles contain. Traced end to end:
    // with real dollar-quoted rows pasted in, every guard passes, the
    // synthetic-fixture tests match nothing against their own libraries, and
    // the whole suite stays green -- so the header's "goes red the moment
    // real rows land" contract, and the byte-assertion gate it defers to,
    // would both be bypassable without this second assertion.
    expect(sqlOnly).not.toMatch(DOLLAR_QUOTE_PATTERN);
  });

  test('the dollar-quote paste gate catches tags containing digits', () => {
    // Round 5 finding: the pattern was /\$[A-Za-z_]*\$/, which cannot match
    // `$q1$` or `$tag1$` -- the character class excludes digits and there is
    // no second class for the tail. A real 14-row paste using such a tag
    // carries no apostrophe, so it slipped BOTH assertions and the header's
    // "goes red the moment real rows land" contract (and the byte-exact
    // codepoint assertion it defers to) was bypassable.
    //
    // Asserted against a realistic ACCENTED payload on purpose. With an
    // ASCII-only value the old pattern matched by ACCIDENT -- in
    // `$q1$Csillagrablok$q1$` the substring `$Csillagrablok$` is itself a
    // valid `\$[A-Za-z_]*\$` match -- so an ASCII fixture reports the hole as
    // already closed. The accent is what breaks that coincidence.
    const realPastes = [
      "(50340, 3, 'Csillagrablók', NULL)",
      '(50340, 3, $$Csillagrablók$$, NULL)',
      '(50340, 3, $q1$Csillagrablók$q1$, NULL)',
      '(50340, 3, $tag1$Csillagrablók$tag1$, NULL)',
    ];
    for (const paste of realPastes) {
      expect(paste.includes("'") || DOLLAR_QUOTE_PATTERN.test(paste)).toBe(true);
    }
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
      // Guard-specific fragment (LOW/MEDIUM finding, PR #2154 review round 2
      // -- every guard test previously asserted only the shared /BS#2152
      // guard/ prefix, which any OTHER guard's exception also satisfies; see
      // the mutation-test table in the PR description for which tests this
      // silently under-covered).
    ).rejects.toThrow('specify no replacement');
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

    // Guard-specific fragment (PR #2154 review round 2, finding 4): the
    // generic /BS#2152 guard/ prefix a prior version of this test asserted
    // is shared by all seven guards, so it cannot tell this apart from
    // guard-converging-pending, guard-capture-sanity, etc. firing instead.
    // Round 5 re-pointed this fragment when the guard's message was corrected
    // (it named a violated index that post-round-4 is not the likeliest
    // cause). This test exercises cause (3) -- a duplicate entry in the
    // PENDING block -- so it asserts on that clause specifically; the
    // NFC-fan-out cause (2) has its own test below.
    await expect(runRepairScript(withSyntheticPendingRows([dupPendingRow, { ...dupPendingRow }]))).rejects.toThrow(
      'a duplicate entry in the pending block'
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
      // Guard-specific fragment (PR #2154 review round 2, finding 4).
    ).rejects.toThrow('looks transposed or uncorrupted');

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
      // Guard-specific fragment (PR #2154 review round 2, finding 4).
    ).rejects.toThrow('converge on the same post-fix');

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
      // Guard-specific fragment (PR #2154 review round 2, finding 4).
    ).rejects.toThrow('already been scrubbed');
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

  // ==========================================================================
  // Round 2 review findings (PR #2154 review, second pass against a live
  // Postgres via `psql -f`).
  // ==========================================================================

  test('HIGH: silent row destruction (round 2 repro) -- a row corrupt in BOTH columns but captured with only ONE true_* replacement aborts via guard-post-fix-fffd, BOTH rows survive intact', async () => {
    // Exact reviewer reproduction: two live rows share the SAME corrupt
    // artist_name ('Hermanos Guti<U+FFFD>rrez') -- row 1 is corrupt ONLY in
    // artist_name (its track_title is already clean), row 2 is corrupt in
    // BOTH columns. The pending capture fixes row 2's track_title but
    // (the operator slip) leaves true_artist_name NULL even though row 2's
    // artist_name is ALSO corrupt. Unguarded: new_artist_name stays
    // 'Hermanos Guti<U+FFFD>rrez' (untouched), new_track_title becomes the
    // fixed 'Sonido Cósmico' -- which is now BYTE-IDENTICAL to row 1's
    // existing (artist_name, track_title) tuple, so row 1 resolves as row
    // 2's "twin" and gets DELETEd, destroying the row that was actually
    // targeted for repair while row 1's corruption survives untouched.
    const libraryId = await seedLibrary(90022);
    const row1Id = await seedCta(libraryId, 'Hermanos Guti�rrez', 'Sonido Cósmico', '2');
    const row2Id = await seedCta(libraryId, 'Hermanos Guti�rrez', 'Sonido C�smico', '7');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90022,
            track_position: '7',
            current_artist_name: 'Hermanos Guti�rrez',
            current_track_title: 'Sonido C�smico',
            true_track_title: 'Sonido Cósmico',
            // true_artist_name deliberately omitted, even though row 2's
            // artist_name is ALSO corrupt -- the exact capture slip finding
            // 1 (round 2) reproduced.
          },
        ])
      )
      // Guard-specific fragment.
    ).rejects.toThrow('still carries U+FFFD in its post-fix tuple');

    // Both rows survive, byte for byte -- the guard fires before BEGIN's
    // writes run (and even if it fired later, the ROLLBACK in
    // runRepairScript's catch block would undo it).
    const row1 = await ctaRow(row1Id);
    expect(row1.artist_name).toBe('Hermanos Guti�rrez');
    expect(row1.track_title).toBe('Sonido Cósmico');
    const row2 = await ctaRow(row2Id);
    expect(row2.artist_name).toBe('Hermanos Guti�rrez');
    expect(row2.track_title).toBe('Sonido C�smico');
    expect(await ctaCount(libraryId)).toBe(2);
  });

  test('HIGH: silent partial repair (round 2 repro) -- a row corrupt in BOTH columns, no twin, captured with only ONE true_* replacement aborts via guard-post-fix-fffd instead of half-writing', async () => {
    // Exact reviewer reproduction: no twin exists anywhere for this credit,
    // so unguarded the UPDATE branch would run and write only the supplied
    // column -- exit 0, the per-row postlude residual would read 0 against
    // this row's OLD tuple (which no longer exists), but the overall
    // residual counter would still show 1 with no row-level indication of
    // which row is still wrong.
    const libraryId = await seedLibrary(90023);
    const corruptId = await seedCta(libraryId, 'Csillagrabl�k', 'Rem�nytelen T�nc', '4');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90023,
            track_position: '4',
            current_artist_name: 'Csillagrabl�k',
            current_track_title: 'Rem�nytelen T�nc',
            true_track_title: 'Reménytelen Tánc',
            // true_artist_name omitted, even though artist_name is ALSO corrupt.
          },
        ])
      )
    ).rejects.toThrow('still carries U+FFFD in its post-fix tuple');

    const row = await ctaRow(corruptId);
    expect(row.artist_name).toBe('Csillagrabl�k'); // untouched -- not half-written
    expect(row.track_title).toBe('Rem�nytelen T�nc');
  });

  test('a row corrupt in BOTH columns, captured CORRECTLY as one pending row with BOTH true_* values, repairs cleanly (the shape step 4 of the header now documents)', async () => {
    const libraryId = await seedLibrary(90024);
    const corruptId = await seedCta(libraryId, 'Csillagrabl�k', 'Rem�nytelen T�nc', '4');

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90024,
          track_position: '4',
          current_artist_name: 'Csillagrabl�k',
          current_track_title: 'Rem�nytelen T�nc',
          true_artist_name: 'Csillagrablók',
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

  test('MEDIUM: guard-nfc-form rejects a true_* replacement pasted in a non-NFC Unicode normalization form', async () => {
    await seedLibrary(90025);
    // NFD: a bare 'o' followed by a standalone COMBINING ACUTE ACCENT
    // (U+0301), rather than the precomposed 'ó' (U+00F3) every other test in
    // this file uses -- exactly the shape a MySQL client or a different OS
    // clipboard normalization can hand an operator without either of them
    // noticing, since both render identically.
    const nfdTrackTitle = 'Sonido Cósmico';
    expect(nfdTrackTitle.normalize('NFC')).not.toBe(nfdTrackTitle);
    expect(nfdTrackTitle.normalize('NFC')).toBe('Sonido Cósmico');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90025,
            track_position: '1',
            current_artist_name: 'Hermanos Gutiérrez',
            current_track_title: 'Sonido C�smico',
            true_track_title: nfdTrackTitle,
          },
        ])
      )
      // Guard-specific fragment.
    ).rejects.toThrow('not NFC-normalized');
  });

  test("MEDIUM: repoint-twin-identity re-checks the corrupt row is unchanged before repointing, mirroring delete-twins' own re-check", async () => {
    // A concurrent edit to the corrupt row's artist_name landing AFTER
    // build-targets but BEFORE repoint-twin-identity -- e.g. a same-cycle
    // library-etl write, or a librarian hand-edit -- means the corrupt row
    // no longer matches its captured old_artist_name/old_track_title.
    // delete-twins' own re-check already skips deleting it in that case;
    // before this fix, repoint-twin-identity had no equivalent re-check, so
    // it would still repoint the twin's identity link even though the
    // corrupt row it came from was never actually deleted -- silently
    // duplicating the identity link across two live rows.
    const libraryId = await seedLibrary(90026);
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

    // Injected through runRepairScript's own hook rather than hand-copying
    // the block sequence (PR #2154 review round 3). The inlined copy this
    // replaces both drifted from the real order and, lacking the helper's
    // catch/ROLLBACK, could hand an aborted-transaction connection back to
    // the shared pool. The hook fires between build-targets and lock-targets,
    // which after round 3 is the ONLY window in which a concurrent edit to a
    // classified row is still possible at all.
    await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90026,
          track_position: '4',
          current_artist_name: 'Hermanos Gutiérrez',
          current_track_title: 'Sonido C�smico',
          true_track_title: 'Sonido Cósmico',
        },
      ]),
      {
        afterBuildTargets: async () => {
          // A SECOND session. READ COMMITTED means this ordinary UPDATE is
          // not blocked here -- build-targets' CREATE TEMP TABLE ... AS
          // SELECT took no row lock, and lock-targets has not run yet.
          await sql`
            UPDATE ${sql(TEST_SCHEMA)}.compilation_track_artist
               SET artist_name = 'Somebody Else Entirely'
             WHERE id = ${corruptId}
          `;
        },
      }
    );

    // The twin's identity link was NOT repointed -- the re-check in
    // repoint-twin-identity found the corrupt row no longer matched its
    // captured old_artist_name and skipped.
    const twin = await ctaRow(twinId);
    expect(twin.track_artist_id).toBeNull();
    expect(twin.track_artist_link_confidence).toBeNull();
    expect(twin.track_artist_link_method).toBeNull();

    // The concurrently-edited row survives untouched by this run (delete-
    // twins' own pre-existing re-check already covered this half).
    const corrupt = await ctaRow(corruptId);
    expect(corrupt.artist_name).toBe('Somebody Else Entirely');

    // guard-repair-complete does NOT fire here, and that is the intended
    // asymmetry: nothing live still holds the captured corrupt tuple (the
    // concurrent editor rewrote it), so this run legitimately wrote nothing
    // and committed. Contrast the vanished-twin test below, where the corrupt
    // tuple IS still live after the writes and the guard aborts.
  });

  // ==========================================================================
  // Round 3 review findings (PR #2154 review, third pass).
  // ==========================================================================

  test('HIGH: a twin deleted between build-targets and lock-targets makes delete-twins decline, and guard-repair-complete refuses to COMMIT the un-repaired run -- the corrupt row is the last copy of the credit and survives', async () => {
    // Through round 2 both write statements re-checked only the row they were
    // about to touch, never the twin that was supposed to carry the credit
    // forward. `twin.id = t.twin_id` is a snapshot from build-targets, so a
    // twin deleted (or renamed) in the window let delete-twins remove what had
    // by then become the ONLY remaining copy -- committing at exit 0, with a
    // per-row residual of 0 because the residual counts the OLD tuple, which
    // the delete genuinely did remove. The UPDATE branch never had this
    // exposure (it fails safe into a 23505); the DELETE branch had no tripwire.
    const libraryId = await seedLibrary(90030);
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '2');
    const corruptId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '7');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90030,
            track_position: '7',
            current_artist_name: 'Hermanos Gutiérrez',
            current_track_title: 'Sonido C�smico',
            true_track_title: 'Sonido Cósmico',
          },
        ]),
        {
          afterBuildTargets: async () => {
            await sql`
              DELETE FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${twinId}
            `;
          },
        }
      )
    ).rejects.toThrow('still holds its corrupt tuple');

    // The credit survives. This is the assertion the whole finding is about:
    // without delete-twins' twin re-check the corrupt row is gone here and the
    // compilation has lost the credit entirely, with the script reporting
    // success. Corrupt-but-present is recoverable; absent is not.
    const corrupt = await ctaRow(corruptId);
    expect(corrupt.artist_name).toBe('Hermanos Gutiérrez');
    expect(corrupt.track_title).toBe('Sonido C�smico');
    // Only the concurrently-deleted twin is gone -- that delete belongs to
    // another committed transaction and is not ours to roll back.
    expect(await ctaCount(libraryId)).toBe(1);
  });

  test('HIGH: lock-targets takes real row locks on BOTH the corrupt row and its twin, so no concurrent writer can reach them between classification and the writes', async () => {
    // The mechanism the round 3 concurrency fixes rest on. Through round 2 the
    // script narrowed the classify-then-write window with re-checks but never
    // closed it, which is what let repoint-twin-identity and delete-twins
    // disagree with each other (repoint fires, edit lands, delete correctly
    // declines -- identity link duplicated across two live rows, committed).
    // Both are locked: the twin matters as much as the corrupt row, since the
    // write statements read and mutate both.
    const libraryId = await seedLibrary(90031);
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '2');
    const corruptId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '7');

    // Bounded with lock_timeout so a genuinely-held lock surfaces as an error
    // rather than hanging the suite forever if this assertion ever regresses.
    async function tryConcurrentUpdate(id) {
      const other = await sql.reserve();
      try {
        await other.unsafe('BEGIN');
        await other.unsafe("SET LOCAL lock_timeout = '250ms'");
        try {
          await other.unsafe(
            `UPDATE ${TEST_SCHEMA}.compilation_track_artist SET track_position = '99' WHERE id = ${id}`
          );
          await other.unsafe('ROLLBACK');
          return null;
        } catch (err) {
          await other.unsafe('ROLLBACK');
          return err;
        }
      } finally {
        other.release();
      }
    }

    const blocked = {};
    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90031,
          track_position: '7',
          current_artist_name: 'Hermanos Gutiérrez',
          current_track_title: 'Sonido C�smico',
          true_track_title: 'Sonido Cósmico',
        },
      ]),
      {
        // AFTER lock-targets (afterGuards runs later in the sequence), so the
        // locks are held. The same writes succeed from the afterBuildTargets
        // hook the two tests above use, which is precisely the difference the
        // lock makes.
        afterGuards: async () => {
          blocked.corrupt = await tryConcurrentUpdate(corruptId);
          blocked.twin = await tryConcurrentUpdate(twinId);
        },
      }
    );

    expect(blocked.corrupt).not.toBeNull();
    expect(blocked.corrupt.code).toBe('55P03'); // lock_not_available
    expect(blocked.twin).not.toBeNull();
    expect(blocked.twin.code).toBe('55P03');

    // The repair itself still completed normally with the locks held.
    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(0);
    const twin = await ctaRow(twinId);
    expect(twin.track_title).toBe('Sonido Cósmico');
    expect(await ctaCount(libraryId)).toBe(1);
  });

  test('MEDIUM: the shipped scrub DELETE is conditional on the FULL all-NULL placeholder shape -- reverting it to the unconditional `WHERE legacy_release_id IS NULL` form is caught', async () => {
    // Round 3 finding: no test previously ran the SHIPPED scrub against any
    // row but its own placeholder. The synthetic path skips
    // `insert-pending-rows` entirely, and the one test that does execute it
    // carries zero other pending rows -- where the conditional and
    // unconditional DELETEs are indistinguishable. So the round 2 fix for this
    // exact bug was pinned only by the guard's existence, not by the scrub's
    // conditionality, and reverting the scrub left the whole suite green.
    //
    // The paste-slip row has to exist BEFORE the shipped block runs, or its
    // scrub never sees it -- which is why this cannot be expressed through
    // withSyntheticPendingRows.
    await seedLibrary(90027);
    await expect(
      runRepairScript(async (reservedSql) => {
        await insertSyntheticPendingRows(reservedSql, [
          {
            legacy_release_id: null,
            track_position: '2',
            current_artist_name: 'Some Other Artist',
            current_track_title: 'Some Other Title',
            true_artist_name: 'Fixed Other Artist',
          },
        ]);
        await reservedSql.unsafe(blocks['insert-pending-rows']);
      })
    ).rejects.toThrow('already been scrubbed');
  });

  test('MEDIUM: a NULL current_artist_name on a track_title-only repair aborts via guard-capture-sanity instead of silently matching nothing', async () => {
    // Round 3 finding: guard-capture-sanity's NULL test sat inside the
    // `true_artist_name IS NOT NULL` branch, so it never applied to the 11
    // track_title-only rows -- where a NULLed current_artist_name passed every
    // guard, matched no live row (build-targets joins on
    // `cta.artist_name = p.current_artist_name`), and committed as a silent
    // no-op with the corruption intact. prod's artist_name column is NOT NULL
    // and the enumeration query cannot emit a NULL there, so this is always a
    // paste slip and is now always fatal.
    const libraryId = await seedLibrary(90028);
    const corruptId = await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90028,
            track_position: '4',
            current_artist_name: null, // paste slip -- one column short
            current_track_title: 'Rem�nytelen T�nc',
            true_track_title: 'Reménytelen Tánc',
          },
        ])
      )
      // The guard names the ACTUAL fault rather than ORing both of its
      // diagnoses into one message -- a short paste and a transposed paste
      // have different fixes, and this fragment would match the transposed
      // wording too if it didn't.
    ).rejects.toThrow('current_artist_name is NULL');

    const row = await ctaRow(corruptId);
    expect(row.artist_name).toBe('Csillagrablók');
    expect(row.track_title).toBe('Rem�nytelen T�nc');
  });

  test('MEDIUM: a legacy_release_id resolving to no library row aborts via guard-unknown-release, not the merely-informational unmatched listing', async () => {
    // The one unmatched shape that can never be an idempotent re-run:
    // repairing a CTA row does not delete or re-key its `library` parent, so a
    // release id that resolves to nothing is a transcription error in the
    // paste. Before round 3 it was swept into the same INFO listing as the
    // benign already-fixed case and the run exited 0.
    const libraryId = await seedLibrary(90029);
    const corruptId = await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90999, // no library row carries this id
            track_position: '4',
            current_artist_name: 'Csillagrablók',
            current_track_title: 'Rem�nytelen T�nc',
            true_track_title: 'Reménytelen Tánc',
          },
        ])
      )
      // Schema-free fragment: the message names wxyc_schema.library, which the
      // extractor rewrites to the throwaway schema.
    ).rejects.toThrow('matches no row in');

    const row = await ctaRow(corruptId);
    expect(row.track_title).toBe('Rem�nytelen T�nc');
  });

  // ==========================================================================
  // Round 4 review findings (Unicode composition-form mismatch, BS#2152).
  // ==========================================================================

  test('BS#2152 round 4: an NFD-stored clean twin against an NFC true_* capture now classifies as a twin, takes the DELETE branch, and leaves exactly one (NFD) row with the U+FFFD gone', async () => {
    // The defect this round closes: build-targets' twin join used to compare
    // twin.artist_name/twin.track_title to the post-fix tuple byte-exactly.
    // guard-nfc-form pins every captured true_* value to NFC, but a LIVE row
    // carries no such invariant -- this table has no fold trigger the way
    // `artists` does -- so a genuinely NFD-stored clean twin is possible, and
    // it is exactly what the byte-exact join missed. Before this fix, the
    // run below would classify no-twin, UPDATE the corrupt row onto the NFC
    // value, and leave TWO rows (one NFD, one NFC) for the same credit --
    // with the postlude still reading 0/0, because the U+FFFD really was
    // gone; what was left behind was a duplicate, not a U+FFFD.
    const libraryId = await seedLibrary(90040);
    const nfdTrackTitle = 'Sonido Cósmico'.normalize('NFD');
    expect(nfdTrackTitle).not.toBe('Sonido Cósmico');
    expect(nfdTrackTitle.normalize('NFC')).toBe('Sonido Cósmico');

    // The corrupt row carries an identity link the clean twin lacks (the
    // usual shape -- the corrupt row is the OLDER ingestion, see
    // repoint-twin-identity's own comment). This is deliberate, not just
    // fixture texture: repoint-twin-identity has its OWN NFC-folded
    // twin-match re-check (coupling 2 in the round 4 review), separate from
    // delete-twins'. A mutation that reverted ONLY repoint's fold would
    // still let delete-twins remove the corrupt row correctly -- same row
    // counts, same surviving id, same bytes -- but the identity link would
    // silently fail to carry over, since repoint's own WHERE would then
    // match zero rows against this NFD twin. Asserting on the identity
    // columns below is what makes that failure mode visible instead of
    // masked by delete-twins' independent fix.
    const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', nfdTrackTitle, '2');
    const corruptId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '7', {
      track_artist_id: 4242,
      track_artist_link_confidence: 0.93,
      track_artist_link_method: 'lml_backfill',
    });

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90040,
          track_position: '7',
          current_artist_name: 'Hermanos Gutiérrez',
          current_track_title: 'Sonido C�smico',
          true_track_title: 'Sonido Cósmico', // NFC, as guard-nfc-form requires
        },
      ])
    );

    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(0);

    // Exactly one row survives -- the corrupt row is gone, not duplicated.
    expect(await ctaCount(libraryId)).toBe(1);
    const remaining = await sql`
      SELECT id, artist_name, track_title FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE library_id = ${libraryId}
    `;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(twinId);

    // The surviving row is the ORIGINAL NFD twin, byte for byte -- detection
    // folds to NFC, writes never do. The corrupt row was DELETEd, not
    // rewritten, so nothing here was ever written in a normalized form.
    expect(remaining[0].track_title).toBe(nfdTrackTitle);
    expect(remaining[0].track_title.normalize('NFC')).toBe('Sonido Cósmico');

    // The corrupt row's identity link carried over onto the NFD twin --
    // this only happens if repoint-twin-identity's OWN NFC-folded
    // twin-match re-check actually fired against the NFD twin (see the
    // seeding comment above for why this is load-bearing, not incidental).
    const twin = await ctaRow(twinId);
    expect(twin.track_artist_id).toBe(4242);
    expect(twin.track_artist_link_confidence).toBeCloseTo(0.93);
    expect(twin.track_artist_link_method).toBe('lml_backfill');

    const corruptGone = await sql`
      SELECT id FROM ${sql(TEST_SCHEMA)}.compilation_track_artist WHERE id = ${corruptId}
    `;
    expect(corruptGone).toHaveLength(0);

    // The U+FFFD predicate is 0 across both columns -- the same postlude
    // read the pre-fix defect also passed, which is why this scenario needs
    // its own row-count/identity assertions rather than trusting the
    // residual count alone.
    const [{ remainingFffd }] = await sql`
      SELECT COUNT(*)::int AS "remainingFffd"
      FROM ${sql(TEST_SCHEMA)}.compilation_track_artist
      WHERE library_id = ${libraryId}
        AND (artist_name LIKE '%' || chr(65533) || '%' OR track_title LIKE '%' || chr(65533) || '%')
    `;
    expect(remainingFffd).toBe(0);
  });

  test('BS#2152 round 4: two pending rows converging only AFTER NFC folding (via the untouched COALESCE column) abort via guard-converging-pending', async () => {
    // Coupling 3 from the round 4 review: guard-converging-pending groups on
    // the post-fix tuple, but `new_artist_name`/`new_track_title` COALESCE
    // onto whichever column a pending row does NOT fix -- and that untouched
    // column carries no NFC invariant (see "Unicode normalization" above).
    // So two pending rows can converge on the same real credit via a form
    // mismatch alone, with no true_* value even involved in the mismatch
    // that causes the convergence. Byte-exact grouping would miss this and
    // let BOTH rows reach update-no-twins, which -- being NFC-equal but
    // byte-DISTINCT -- does NOT trip cta_unique_idx, so the run would exit 0
    // having created exactly the round-4 duplicate class this whole fix
    // exists to prevent.
    const libraryId = await seedLibrary(90042);
    const nfdTrackTitle = 'Sonido Cósmico'.normalize('NFD');

    // Row A: corrupt artist_name; track_title untouched and stored NFD.
    await seedCta(libraryId, 'Hermanos Guti�rrez', nfdTrackTitle, '1');
    // Row B: artist_name already clean NFC; corrupt track_title.
    await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '2');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90042,
            track_position: '1',
            current_artist_name: 'Hermanos Guti�rrez',
            current_track_title: nfdTrackTitle,
            true_artist_name: 'Hermanos Gutiérrez', // NFC
            // true_track_title omitted -- new_track_title COALESCEs onto
            // this row's own (NFD) live track_title.
          },
          {
            legacy_release_id: 90042,
            track_position: '2',
            current_artist_name: 'Hermanos Gutiérrez',
            current_track_title: 'Sonido C�smico',
            true_track_title: 'Sonido Cósmico', // NFC
            // true_artist_name omitted -- new_artist_name COALESCEs onto
            // this row's own (already-NFC) live artist_name.
          },
        ])
      )
      // Guard-specific fragment -- distinguishes a genuine
      // guard-converging-pending catch from guard-post-write-nfc-duplicate,
      // which would ALSO fire on this exact scenario if THIS guard's own
      // fold were reverted (see the round 4 mutation table): the two guards
      // overlap on this input, so only the message text tells them apart.
    ).rejects.toThrow('converge on the same post-fix');

    // Both rows survive untouched -- the transaction rolled back before
    // either write statement ran.
    const rows = await sql`
      SELECT artist_name, track_title FROM ${sql(TEST_SCHEMA)}.compilation_track_artist
      WHERE library_id = ${libraryId} ORDER BY track_position
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].artist_name).toBe('Hermanos Guti�rrez');
    expect(rows[0].track_title).toBe(nfdTrackTitle);
    expect(rows[1].artist_name).toBe('Hermanos Gutiérrez');
    expect(rows[1].track_title).toBe('Sonido C�smico');
  });

  // ==========================================================================
  // Round 5 review findings.
  // ==========================================================================

  test('BS#2152 round 5: a pre-existing NFC/NFD duplicate this run never wrote does NOT block an unrelated repair in the same compilation', async () => {
    // Round 4 shipped guard-post-write-nfc-duplicate scoped to "any
    // library_id in cta_repair_targets", which made any pre-existing
    // duplicate pair a hard blocker for the ENTIRE 14-row repair: the
    // legitimate no-twin UPDATE below succeeded, the guard then fired on a
    // pair it never touched, and the whole transaction rolled back. The
    // repair could not complete until a human merged a duplicate that had
    // nothing to do with it -- in the same table #1996 is separately blocked
    // on. This test is the round-4 test inverted: same fixture, opposite
    // expectation.
    const libraryId = await seedLibrary(90041);
    const nfdTitle = 'Sonido Cósmico'.normalize('NFD');
    await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '1'); // NFC
    await seedCta(libraryId, 'Hermanos Gutiérrez', nfdTitle, '2'); // NFD -- same credit, pre-existing duplicate

    const corruptId = await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90041,
          track_position: '4',
          current_artist_name: 'Csillagrablók',
          current_track_title: 'Rem�nytelen T�nc',
          true_track_title: 'Reménytelen Tánc',
        },
      ])
    );

    expect(result.updated).toBe(1);
    const row = await ctaRow(corruptId);
    expect(row.track_title).toBe('Reménytelen Tánc');

    // The pre-existing pair is still there, untouched. That is #1996's
    // territory, not this script's -- what matters is that it no longer
    // vetoes a U+FFFD repair.
    expect(await ctaCount(libraryId)).toBe(3);
  });

  test('BS#2152 round 5: guard-post-write-nfc-duplicate still fires when a row THIS run wrote is half of the duplicate', async () => {
    // The narrowing must not neuter the guard. A concurrent INSERT is the one
    // shape lock-targets structurally cannot prevent -- it takes row locks on
    // rows that EXIST at classification time, and a brand-new row has none to
    // take. Injected through the afterGuards hook so it lands in the real
    // window: after the twin join has already concluded "no twin", before
    // update-no-twins writes.
    const libraryId = await seedLibrary(90042);
    const corruptId = await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90042,
            track_position: '4',
            current_artist_name: 'Csillagrablók',
            current_track_title: 'Rem�nytelen T�nc',
            true_track_title: 'Reménytelen Tánc',
          },
        ]),
        {
          afterGuards: async (reservedSql) => {
            await reservedSql.unsafe(
              `INSERT INTO ${TEST_SCHEMA}.compilation_track_artist (library_id, artist_name, track_title, track_position)
               VALUES (${libraryId}, 'Csillagrablók', normalize('Reménytelen Tánc', NFD), '9')`
            );
          },
        }
      )
    ).rejects.toThrow('NFC-equal but byte-distinct');

    // And now the message's rollback advice is honest: undoing this run's
    // write genuinely removes this run's half of the pair.
    const row = await ctaRow(corruptId);
    expect(row.track_title).toBe('Rem�nytelen T�nc');
  });

  test('BS#2152 round 5: an NFC-folded twin join that fans out to TWO live twins aborts via guard-ambiguous-match, naming the fold rather than a violated index', async () => {
    // Pre-round-4 the twin join was byte-exact on exactly cta_unique_idx's
    // key, so it could structurally match at most one row and the guard's
    // "cta_unique_idx should make this impossible" message was true. Folded
    // to NFC, no unique index backs the compared key -- cta_unique_null_track_idx
    // is precisely the index that cannot constrain two NFC-equal,
    // byte-distinct names -- so a pre-existing NFD/NFC clean pair fans one
    // pending row out to two target rows. Aborting is right; blaming an index
    // that was never violated sends the operator looking for the wrong thing.
    const libraryId = await seedLibrary(90043);
    await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '1'); // NFC twin candidate
    await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico'.normalize('NFD'), '2'); // NFD twin candidate
    const corruptId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '4');

    await expect(
      runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: 90043,
            track_position: '4',
            current_artist_name: 'Hermanos Gutiérrez',
            current_track_title: 'Sonido C�smico',
            true_track_title: 'Sonido Cósmico',
          },
        ])
      )
    ).rejects.toThrow('NFC-folded twin join matched MORE THAN ONE live twin');

    const row = await ctaRow(corruptId);
    expect(row.track_title).toBe('Sonido C�smico');
    expect(await ctaCount(libraryId)).toBe(3);
  });

  test.each([
    {
      shape: 'twin linked, corrupt row carries a different link',
      legacyReleaseId: 90044,
      twin: { track_artist_id: 1111, track_artist_link_confidence: null, track_artist_link_method: 'librarian' },
      corrupt: { track_artist_id: 4242, track_artist_link_confidence: 0.5, track_artist_link_method: 'lml_backfill' },
      expected: { track_artist_id: 1111, track_artist_link_confidence: null, track_artist_link_method: 'librarian' },
    },
    {
      shape: 'twin orphaned by ON DELETE SET NULL, corrupt row carries a whole link',
      legacyReleaseId: 90045,
      twin: { track_artist_id: null, track_artist_link_confidence: 0.93, track_artist_link_method: 'lml_backfill' },
      corrupt: { track_artist_id: 4242, track_artist_link_confidence: 0.5, track_artist_link_method: 'lml_backfill' },
      expected: { track_artist_id: 4242, track_artist_link_confidence: 0.5, track_artist_link_method: 'lml_backfill' },
    },
  ])(
    'BS#2152 round 5: repoint-twin-identity moves the identity link as one TUPLE, not column-by-column ($shape)',
    async ({ legacyReleaseId, twin, corrupt, expected }) => {
      // Per-column COALESCE merges two DIFFERENT links into one incoherent
      // row. Shape 1 previously produced (id=1111, confidence=0.5,
      // method='librarian') -- a machine confidence computed for artist 4242,
      // attached to artist 1111, labelled human-entered, which
      // library-identity-consumer's librarian precedence then skips forever.
      // Shape 2 previously produced (id=4242, confidence=0.93,
      // method='lml_backfill') -- the corrupt row's artist under the twin's
      // stale orphaned confidence. Both are reachable today: track_artist_id
      // is ON DELETE SET NULL on artists.id (migration 0140), so any artist
      // deletion leaves the partial shape behind.
      //
      // Neither existing repoint test covers this -- both seed the twin with
      // all three columns NULL or all three set, the two shapes where
      // per-column and per-tuple COALESCE agree.
      const libraryId = await seedLibrary(legacyReleaseId);
      const twinId = await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido Cósmico', '2', twin);
      await seedCta(libraryId, 'Hermanos Gutiérrez', 'Sonido C�smico', '4', corrupt);

      await runRepairScript(
        withSyntheticPendingRows([
          {
            legacy_release_id: legacyReleaseId,
            track_position: '4',
            current_artist_name: 'Hermanos Gutiérrez',
            current_track_title: 'Sonido C�smico',
            true_track_title: 'Sonido Cósmico',
          },
        ])
      );

      const survivor = await ctaRow(twinId);
      expect(survivor.track_artist_id).toBe(expected.track_artist_id);
      expect(survivor.track_artist_link_method).toBe(expected.track_artist_link_method);
      if (expected.track_artist_link_confidence === null) {
        expect(survivor.track_artist_link_confidence).toBeNull();
      } else {
        expect(survivor.track_artist_link_confidence).toBeCloseTo(expected.track_artist_link_confidence);
      }
    }
  );

  test('BS#2152 round 5: the BEFORE print surfaces the twin bytes the DELETE branch keeps, so a discarded NFC capture is visible', async () => {
    // On the widened DELETE branch the row that SURVIVES is the twin,
    // byte-for-byte -- so an NFD twin against an NFC capture means the bytes
    // the operator read out of Kattare are discarded. Exit 0, residual 0/0,
    // no duplicate, and (through round 4) no signal of any kind: the print
    // projected twin_id and the three twin_track_artist_* columns but not the
    // twin's own name/title.
    //
    // This test also covers the mechanism half of the same finding: the block
    // is EXECUTED here (it was untagged and therefore unexecuted through
    // round 4 -- the one statement in the file whose reversion broke no test,
    // while a real psql -f run exited 3 on a column typo).
    const libraryId = await seedLibrary(90046);
    const nfdTitle = 'Reménytelen Tánc'.normalize('NFD');
    const twinId = await seedCta(libraryId, 'Csillagrablók', nfdTitle, '2');
    await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

    const result = await runRepairScript(
      withSyntheticPendingRows([
        {
          legacy_release_id: 90046,
          track_position: '4',
          current_artist_name: 'Csillagrablók',
          current_track_title: 'Rem�nytelen T�nc',
          true_track_title: 'Reménytelen Tánc', // NFC
        },
      ])
    );

    expect(result.deleted).toBe(1);

    const printed = result.beforeMatched;
    expect(printed).toHaveLength(1);
    expect(printed[0].action).toBe('DELETE (twin exists)');
    expect(printed[0].twin_track_title).toBe(nfdTitle);
    expect(printed[0].new_track_title).toBe('Reménytelen Tánc');
    // The whole point: the operator can see these differ before committing.
    expect(printed[0].twin_is_byte_exact).toBe(false);

    // And the survivor really does hold the NFD bytes, not the capture.
    const survivor = await ctaRow(twinId);
    expect(survivor.track_title).toBe(nfdTitle);
    expect(survivor.track_title).not.toBe('Reménytelen Tánc');
  });

  test('BS#2152 round 5: guard-converging-pending tells the operator the both-captures-correct remedy, not just "resolve which is correct"', async () => {
    // The guard is deliberately over-broad and fires on the shape the script
    // itself calls the 98.5% case -- two differently-corrupted copies of ONE
    // credit, both captures correct, neither a distinct real credit. The
    // over-breadth is justified in the comment; the MESSAGE was not, and the
    // workable remedy (split across two sequential invocations) appeared
    // nowhere in the message, the comment, or the capture procedure.
    const libraryId = await seedLibrary(90047);
    await seedCta(libraryId, 'Csillagrablók', 'Reménytelen Tánc', '1'); // clean third row
    await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');
    await seedCta(libraryId, 'Csillagrablók', 'Reménytelen T�nc', '5');

    const pending = [
      {
        legacy_release_id: 90047,
        track_position: '4',
        current_artist_name: 'Csillagrablók',
        current_track_title: 'Rem�nytelen T�nc',
        true_track_title: 'Reménytelen Tánc',
      },
      {
        legacy_release_id: 90047,
        track_position: '5',
        current_artist_name: 'Csillagrablók',
        current_track_title: 'Reménytelen T�nc',
        true_track_title: 'Reménytelen Tánc',
      },
    ];

    await expect(runRepairScript(withSyntheticPendingRows(pending))).rejects.toThrow(
      'split the converging rows across two sequential invocations'
    );
  });

  test.each([
    { legacyReleaseId: 90048, value: 'Reménytelen Tánc   ', label: 'trailing whitespace' },
    { legacyReleaseId: 90049, value: '   Reménytelen Tánc', label: 'leading whitespace' },
    { legacyReleaseId: 90050, value: '', label: 'empty string' },
  ])(
    'BS#2152 round 5: guard-capture-sanity rejects a true_* capture with $label',
    async ({ legacyReleaseId, value }) => {
      // Capture channel (a) trims and maps empty to NULL; channel (c) -- raw
      // Kattare MySQL, which the header explicitly offers -- does not. The
      // consequence is not cosmetic: library-etl's importCompilationTracks
      // inserts the TRIMMED string and its ON CONFLICT DO NOTHING is keyed on
      // cta_unique_idx, so a repaired row differing by whitespace no longer
      // conflicts with it and the next 30-minute cycle re-creates the exact
      // duplicate this script exists to avoid.
      const libraryId = await seedLibrary(legacyReleaseId);
      const corruptId = await seedCta(libraryId, 'Csillagrablók', 'Rem�nytelen T�nc', '4');

      await expect(
        runRepairScript(
          withSyntheticPendingRows([
            {
              legacy_release_id: legacyReleaseId,
              track_position: '4',
              current_artist_name: 'Csillagrablók',
              current_track_title: 'Rem�nytelen T�nc',
              true_track_title: value,
            },
          ])
        )
      ).rejects.toThrow('leading/trailing whitespace or is empty');

      const row = await ctaRow(corruptId);
      expect(row.track_title).toBe('Rem�nytelen T�nc');
    }
  );
});
