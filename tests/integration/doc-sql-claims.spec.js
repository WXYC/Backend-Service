const path = require('path');
const postgres = require('postgres');
const {
  CLAIM_ROLE,
  claimConnectionOptions,
  collectSqlClaims,
  ensureClaimRole,
  evaluateClaim,
  evaluateWithoutLexicalCheck,
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
 * The parse-only half (every block parses, and test.yml's paths-filter lists
 * exactly the docs that hold one) also runs without a database in the
 * unconditional `auth-tables-doc-drift` CI job, via
 * scripts/check-sql-claim-docs.mjs, so a docs-only PR cannot skip it.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

/**
 * Exact claim count per doc. Not a floor: demoting ANY one block to a plain
 * ```sql fence (the one change the parser cannot see, because a plain fence
 * is legitimate markdown) changes a count and fails here. Update this map in
 * the same change that adds or removes a claim, and add a doc when it gains
 * its first block.
 */
const EXPECTED_CLAIM_COUNTS = {
  'docs/adr/0015-catalog-search-query-operators.md': 21,
  'docs/catalog-search/README.md': 10,
};

const connectionBase = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
  database: process.env.DB_NAME || 'wxyc_db',
  user: process.env.DB_USERNAME || 'test-user',
  password: process.env.DB_PASSWORD || 'test-pw',
};

const { claims, errors } = collectSqlClaims(DOCS_DIR, (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/'));

// `sql` is the claim connection. `plain` is writable and opened with every
// layer-5 setting deliberately set to the OPPOSITE of the pin, so a test that
// runs a claim on `plain` proves what the per-claim transaction pins on its
// own. `plain` also creates CLAIM_ROLE, which needs a writable connection.
let sql;
let plain;
beforeAll(async () => {
  sql = postgres(claimConnectionOptions(connectionBase));
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
  await ensureClaimRole(plain);
});
afterAll(async () => {
  if (sql) await sql.end();
  if (plain) await plain.end();
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

  test('the claim transaction runs as the unprivileged claim role, so a superuser-only read is refused', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, 'current_user')).resolves.toBe(CLAIM_ROLE);
    await expect(evaluateWithoutLexicalCheck(plain, "pg_read_file('postgresql.conf')")).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('ensureClaimRole is idempotent on a database that already has the role', async () => {
    await expect(ensureClaimRole(plain)).resolves.toBeUndefined();
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
    const probe = postgres(claimConnectionOptions(connectionBase));
    try {
      await evaluateWithoutLexicalCheck(probe, "set_config('application_name', 'sql-claim-leak', false)");
      const [row] = await probe`SHOW application_name`;
      expect(row.application_name).not.toBe('sql-claim-leak');
    } finally {
      await probe.end();
    }
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
      'current_user',
      'pg_sleep(30)',
      '(SELECT count(*) FROM library)',
    ]) {
      await expect(evaluateClaim(sql, expr)).rejects.toThrow(/not in ALLOWED_FUNCTIONS|unbalanced|not an allowed word/);
    }
  });
});
