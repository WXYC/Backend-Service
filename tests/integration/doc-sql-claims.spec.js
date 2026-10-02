const { randomBytes } = require('crypto');
const path = require('path');
const postgres = require('postgres');
const {
  ROLE_DDL_QUIET_BATCH,
  ROLE_DDL_QUIET_SETTINGS,
  claimConnectionOptions,
  collectSqlClaims,
  createClaimRole,
  dropClaimRole,
  dropStaleClaimRoles,
  evaluateClaim,
  evaluateWithoutLexicalCheck,
  runThenCleanUp,
} = require('../utils/sql-claims');

/**
 * Executes every ```sql-claim block under docs/ (WXYC/Backend-Service#2737).
 *
 * The grammar, the five read-only layers, the function allowlist and its
 * justification, and the note on Postgres-version sensitivity are documented
 * once, in the header of tests/utils/sql-claims.js. Read that before editing
 * a claim or this spec.
 *
 * In short: a claim is `<expression> -> <expected>`, asserting that
 * `SELECT (<expression>)::text` equals `<expected>`. A claim that stops being
 * true fails here by file:line. **If that happens right after a Postgres
 * upgrade, the check is working** — the document's claim stopped being true
 * on the version we now run. Fix the document; do not delete the check.
 *
 * The first `describe` runs the docs' claims and pins each doc's exact claim
 * count. The second pins, against a real server, each read-only layer that
 * does not depend on the lexer, by calling `evaluateWithoutLexicalCheck` (or
 * the raw connection) with input the lexer would have rejected. Each of those
 * tests fails if its layer is removed.
 *
 * The static half (every block parses, each doc's count matches
 * tests/utils/sql-claim-counts.json, test.yml's paths-filter lists exactly
 * the claim-bearing docs, and no tracked .md outside docs/ holds a block) also
 * runs without a database in the unconditional `auth-tables-doc-drift` CI
 * job, via scripts/check-sql-claim-docs.mjs, so a docs-only PR cannot skip it.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

// Exact claim count per doc, not a floor: demoting ANY one block to a plain
// ```sql fence (legitimate markdown the parser cannot flag) changes a count.
// One copy of the map, shared with scripts/check-sql-claim-docs.mjs.
const EXPECTED_CLAIM_COUNTS = require('../utils/sql-claim-counts.json');

const connectionBase = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
  database: process.env.DB_NAME || 'wxyc_db',
  user: process.env.DB_USERNAME || 'test-user',
  password: process.env.DB_PASSWORD || 'test-pw',
};

const { claims, errors } = collectSqlClaims(DOCS_DIR, (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/'));

// `sql` is the claim connection, logged in as this run's own claim role.
// `plain` logs in as the suite's own (superuser) DB user, is writable, and is
// opened with every pinned setting deliberately set to the OPPOSITE of the
// pin, so a test that runs a claim on `plain` proves what the per-claim
// transaction does on its own. `plain` also creates and drops the claim role,
// which needs a superuser.
let sql;
let plain;
let credentials;
beforeAll(async () => {
  plain = postgres({
    ...connectionBase,
    max: 1,
    onnotice: () => {},
    connection: {
      standard_conforming_strings: 'off',
      default_text_search_config: 'pg_catalog.english',
      search_path: 'public',
    },
  });
  await dropStaleClaimRoles(plain);
  credentials = await createClaimRole(plain);
  sql = postgres(claimConnectionOptions(connectionBase, credentials));
});
afterAll(async () => {
  // The claim pool must end before its role can be dropped. Each step runs
  // even if an earlier one failed, so a rejecting end() cannot strand the role.
  await runThenCleanUp(() => {}, [
    () => sql && sql.end(),
    () => plain && credentials && dropClaimRole(plain, credentials.user),
    () => plain && plain.end(),
  ]);
});

describe('docs/**/*.md sql-claim blocks', () => {
  test('every sql-claim block parses (malformed blocks fail by file:line, never skip)', () => {
    expect(errors.map((e) => `${e.file}:${e.line}  ${e.message}`)).toEqual([]);
  });

  test('each doc carries exactly its expected number of claims', () => {
    const counts = {};
    for (const c of claims) counts[c.file] = (counts[c.file] || 0) + 1;
    expect(counts).toEqual(EXPECTED_CLAIM_COUNTS);
  });

  test.each(claims.map((c) => [`${c.file}:${c.line}`, c]))('%s', async (where, claim) => {
    const actual = await evaluateClaim(sql, claim.expr);
    expect({ where, expr: claim.expr, actual }).toEqual({ where, expr: claim.expr, actual: claim.expected });
  });
});

describe('sql-claim runner — read-only layers hold without the lexer', () => {
  // `lo_create` writes (it inserts into pg_largeobject_metadata), is a
  // pg_catalog function, needs no application schema, and is permitted to an
  // unprivileged role, so it is the cleanest probe for "is this transaction
  // read-only".
  const WRITE = 'lo_create(0)';
  // Thrown inside a probe transaction so it always rolls back, even when the
  // layer under test has regressed and the write went through.
  const PROBE_ROLLBACK = new Error('probe rollback');

  test('the claim connection sets every session parameter itself, not by server default', async () => {
    // Listed here, not read from SESSION_PARAMETERS, so dropping one from
    // the module fails this test instead of quietly shrinking it. `source` is
    // 'client' only for a value sent in the startup packet, which tells the
    // pin apart from a server default that happens to match.
    const expected = {
      default_text_search_config: 'pg_catalog.simple',
      default_transaction_read_only: 'on',
      search_path: 'pg_catalog',
      standard_conforming_strings: 'on',
      statement_timeout: '2000',
    };
    const rows = await sql`
      SELECT name, setting, source FROM pg_settings WHERE name IN ${sql(Object.keys(expected))} ORDER BY name`;
    expect(rows.map((r) => [r.name, r.setting, r.source])).toEqual(
      Object.entries(expected).map(([name, setting]) => [name, setting, 'client'])
    );
  });

  test('a write is refused by the claim transaction (BEGIN READ ONLY + session default)', async () => {
    await expect(evaluateWithoutLexicalCheck(sql, WRITE)).rejects.toMatchObject({ code: '25006' });
  });

  test('BEGIN READ ONLY alone refuses a write, on a connection with no read-only session default', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, WRITE)).rejects.toMatchObject({ code: '25006' });
  });

  test('the session default alone refuses a write, in a transaction not opened READ ONLY', async () => {
    const probe = sql.begin(async (tx) => {
      await tx.unsafe(`SELECT ${WRITE}`);
      throw PROBE_ROLLBACK;
    });
    await expect(probe).rejects.toMatchObject({ code: '25006' });
  });

  test('a paren breakout into a second statement is refused by the extended protocol', async () => {
    await expect(evaluateWithoutLexicalCheck(sql, '1)::text; SELECT (1')).rejects.toMatchObject({ code: '42601' });
  });

  test('claims run as the unprivileged claim role, so a superuser-only read is refused', async () => {
    await expect(evaluateWithoutLexicalCheck(sql, 'current_user')).resolves.toBe(credentials.user);
    await expect(evaluateWithoutLexicalCheck(sql, "pg_read_file('postgresql.conf')")).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('each run gets its own role, which authenticates and is dropped without touching another run', async () => {
    const other = await createClaimRole(plain);
    expect(other.user).not.toBe(credentials.user);
    const conn = postgres(claimConnectionOptions(connectionBase, other));
    await runThenCleanUp(
      () => expect(evaluateClaim(conn, "to_tsquery('simple', 'a')")).resolves.toBe("'a'"),
      [() => conn.end(), () => dropClaimRole(plain, other.user)]
    );
    const names = (await plain`SELECT rolname FROM pg_roles WHERE rolname IN (${other.user}, ${credentials.user})`).map(
      (r) => r.rolname
    );
    expect(names).toEqual([credentials.user]);
  });

  test("a crashed run's role is dropped once stale, and a live run's role is not", async () => {
    // A name whose embedded timestamp is 2001: older than any live run's.
    // Random suffix, so concurrent runs never collide on it; either run's
    // cleanup may be the one that drops it.
    const orphan = `wxyc_sql_claim_1000000000_${randomBytes(8).toString('hex')}`;
    await plain.unsafe(`CREATE ROLE ${orphan} NOLOGIN`);
    // A just-created role with no session yet: another run between
    // createClaimRole and its first connection. Too young to be touched.
    const fresh = await createClaimRole(plain);
    await runThenCleanUp(async () => {
      const found = await dropStaleClaimRoles(plain);
      expect(found).not.toContain(credentials.user);
      expect(found).not.toContain(fresh.user);
      const names = (
        await plain`SELECT rolname FROM pg_roles WHERE rolname IN (${orphan}, ${credentials.user}, ${fresh.user})`
      ).map((r) => r.rolname);
      expect(names.sort()).toEqual([credentials.user, fresh.user].sort());
    }, [() => dropClaimRole(plain, fresh.user)]);
  });

  test('the role-DDL quiet batch is accepted by this server, takes effect, and is undone afterwards', async () => {
    // Listed here, not read from the module, so dropping a setting there
    // fails this test. A Postgres upgrade that removes or renames one of
    // the non-dotted names fails here by name. The dotted one cannot fail
    // that way: without its extension loaded it is only a placeholder.
    const expected = {
      debug_print_parse: 'off',
      debug_print_plan: 'off',
      debug_print_rewritten: 'off',
      log_min_duration_sample: '-1',
      log_min_duration_statement: '-1',
      log_min_error_statement: 'panic',
      log_statement: 'none',
      log_transaction_sample_rate: '0',
      'pg_stat_statements.track': 'none',
      track_activities: 'off',
    };
    // Both directions: a setting added to the module must be listed here too.
    expect(ROLE_DDL_QUIET_SETTINGS.map(([name]) => name).sort()).toEqual(Object.keys(expected));
    let inside;
    const probe = plain.begin(async (tx) => {
      await tx.unsafe(ROLE_DDL_QUIET_BATCH);
      inside = {};
      for (const name of Object.keys(expected)) {
        const [row] = await tx`SELECT current_setting(${name}) AS value`;
        inside[name] = row.value;
      }
      throw PROBE_ROLLBACK;
    });
    await expect(probe).rejects.toBe(PROBE_ROLLBACK);
    expect(inside).toEqual(expected);

    // The batch is session-level, so createClaimRole has to undo it. `plain`
    // has one connection and has already run createClaimRole in beforeAll; a
    // missing or partial RESET leaves these away from their session defaults.
    const left = await plain`
      SELECT name, setting, reset_val FROM pg_settings
      WHERE name IN ${plain(Object.keys(expected))} AND setting IS DISTINCT FROM reset_val`;
    expect(left.map((r) => [r.name, r.setting, r.reset_val])).toEqual([]);
    // log_transaction_sample_rate is 0 by default, so the check above cannot
    // see whether it was reset; `source` can.
    const [rate] = await plain`SELECT source FROM pg_settings WHERE name = 'log_transaction_sample_rate'`;
    expect(rate.source).not.toBe('session');
  });

  test('the claim connection logs in as the claim role, which is not a superuser', async () => {
    const [row] = await sql`
      SELECT session_user::text AS who, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = session_user`;
    expect(row).toEqual({
      who: credentials.user,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  });

  // Round-2 review (PR #2746): with the lexer bypassed, an expression that
  // resets the role runs with the SESSION user's privileges. These pin what
  // the claim connection's unprivileged session user buys.
  test.each([
    ['set_config role', `set_config('role', '${connectionBase.user}', true) || current_user::text`],
    ['set_config session_authorization', `set_config('session_authorization', '${connectionBase.user}', true)`],
    [
      'query_to_xml over pg_read_file',
      "query_to_xml('select pg_read_file(''PG_VERSION'') as x', false, false, '')::text",
    ],
  ])('the claim connection refuses re-escalation via %s (42501)', async (_label, expr) => {
    await expect(evaluateWithoutLexicalCheck(sql, expr)).rejects.toMatchObject({ code: '42501' });
  });

  test('RESIDUAL, pinned: a session advisory lock taken under a lexer bypass outlives the rollback', async () => {
    // The lexer never admits pg_advisory_*; this documents what layer 4 does
    // not cover (see the module header's residual list).
    // Session advisory locks are database-wide, so the key is random per run:
    // with a fixed one, a concurrent run against the same database would
    // block here until statement_timeout. 31 bits, so it fits pg_locks.objid.
    const key = randomBytes(4).readUInt32BE() >>> 1;
    // The unlock is a cleanup step, so a failing assertion cannot leave the
    // lock held for the rest of the file.
    await runThenCleanUp(async () => {
      await expect(evaluateWithoutLexicalCheck(sql, `pg_advisory_lock(${key})::text`)).resolves.toBe('');
      const [{ held }] = await sql`
        SELECT count(*)::int AS held FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = 0 AND objid = ${key}`;
      expect(held).toBe(1);
    }, [() => sql`SELECT pg_advisory_unlock_all()`]);
  });

  test('the claim transaction pins search_path to pg_catalog on its own', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, "current_setting('search_path')")).resolves.toBe('pg_catalog');
  });

  test('the claim transaction pins standard_conforming_strings on its own, so a backslash in a literal is literal', async () => {
    // With standard_conforming_strings off (as `plain` opens), `'a\'` is an
    // unterminated literal; pinned on, it is the two characters a and \.
    await expect(evaluateWithoutLexicalCheck(plain, "'a\\'")).resolves.toBe('a\\');
  });

  test('the claim transaction pins default_text_search_config on its own', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, "current_setting('default_text_search_config')")).resolves.toBe(
      'pg_catalog.simple'
    );
  });

  test('the claim transaction cancels a sleeping expression on its own (statement_timeout)', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, 'pg_sleep(30)')).rejects.toMatchObject({ code: '57014' });
  });

  test('the claim transaction is rolled back, so a session change inside it does not outlive it', async () => {
    // set_config(..., is_local => false) survives COMMIT but not ROLLBACK. A
    // dedicated connection, closed afterwards, so a regression cannot leak the
    // setting into the connection the other tests share.
    const probe = postgres(claimConnectionOptions(connectionBase, credentials));
    await runThenCleanUp(async () => {
      await evaluateWithoutLexicalCheck(probe, "set_config('application_name', 'sql-claim-leak', false)");
      const [row] = await probe`SHOW application_name`;
      expect(row.application_name).not.toBe('sql-claim-leak');
    }, [() => probe.end()]);
  });

  test('a negated match verdict evaluates (`not (` is a keyword, not a function call)', async () => {
    await expect(
      evaluateClaim(sql, "not (to_tsvector('simple', 'stereolab') @@ to_tsquery('simple', 'transient'))")
    ).resolves.toBe('true');
  });

  test('the lexer refuses the same probes before they reach the server', async () => {
    for (const expr of [
      WRITE,
      '1)::text; SELECT (1',
      "current_setting('search_path')",
      "pg_read_file('postgresql.conf')",
      "set_config('role', 'postgres', true)",
      "query_to_xml('select 1', false, false, '')",
      'current_user',
      'pg_sleep(30)',
      '(SELECT count(*) FROM library)',
    ]) {
      await expect(evaluateClaim(sql, expr)).rejects.toThrow(/not in ALLOWED_FUNCTIONS|unbalanced|not an allowed word/);
    }
  });
});
