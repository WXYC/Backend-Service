const path = require('path');
const postgres = require('postgres');
const {
  claimConnectionOptions,
  collectSqlClaims,
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
 * The first `describe` runs the docs' claims. The second pins, against a real
 * server, each read-only layer that does not depend on the lexer, by calling
 * `evaluateWithoutLexicalCheck` (or the raw connection) with input the lexer
 * would have rejected. Each of those tests fails if its layer is removed.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const ADR_0015 = 'docs/adr/0015-catalog-search-query-operators.md';

const connectionBase = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
  database: process.env.DB_NAME || 'wxyc_db',
  user: process.env.DB_USERNAME || 'test-user',
  password: process.env.DB_PASSWORD || 'test-pw',
};

const { claims, errors } = collectSqlClaims(DOCS_DIR, (p) => path.relative(REPO_ROOT, p));

let sql;
beforeAll(() => {
  sql = postgres(claimConnectionOptions(connectionBase));
});
afterAll(async () => {
  if (sql) await sql.end();
});

describe('docs/**/*.md sql-claim blocks', () => {
  test('every sql-claim block parses (malformed blocks fail by file:line, never skip)', () => {
    expect(errors.map((e) => `${e.file}:${e.line}  ${e.message}`)).toEqual([]);
  });

  // A floor, not a pin: it catches a block silently demoted to a plain
  // ```sql fence, which the parser cannot see. Raise it when claims are added.
  test(`${ADR_0015} carries at least 16 claims`, () => {
    expect(claims.filter((c) => c.file === ADR_0015).length).toBeGreaterThanOrEqual(16);
  });

  test.each(claims.map((c) => [`${c.file}:${c.line}`, c]))('%s', async (where, claim) => {
    const actual = await evaluateClaim(sql, claim.expr);
    expect({ where, expr: claim.expr, actual }).toEqual({ where, expr: claim.expr, actual: claim.expected });
  });
});

describe('sql-claim runner — read-only layers hold without the lexer', () => {
  // `lo_create` writes (it inserts into pg_largeobject_metadata), is a
  // pg_catalog function, and needs no application schema, so it is the
  // cleanest probe for "is this transaction read-only".
  const WRITE = 'lo_create(0)';

  // A connection WITHOUT the session parameters, so a test run on it proves
  // what the per-claim transaction does on its own.
  let plain;
  beforeAll(() => {
    plain = postgres({ ...connectionBase, max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    if (plain) await plain.end();
  });

  test('the claim connection is read-only, pinned to pg_catalog, and time-limited at the session level', async () => {
    const [ro] = await sql`SHOW default_transaction_read_only`;
    const [sp] = await sql`SHOW search_path`;
    const [st] = await sql`SHOW statement_timeout`;
    expect([ro.default_transaction_read_only, sp.search_path, st.statement_timeout]).toEqual([
      'on',
      'pg_catalog',
      '2s',
    ]);
  });

  test('a write is refused by the claim transaction (BEGIN READ ONLY + session default)', async () => {
    await expect(evaluateWithoutLexicalCheck(sql, WRITE)).rejects.toMatchObject({ code: '25006' });
  });

  test('BEGIN READ ONLY alone refuses a write, on a connection with no read-only session default', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, WRITE)).rejects.toMatchObject({ code: '25006' });
  });

  test('the session default alone refuses a write, in a transaction not opened READ ONLY', async () => {
    await expect(sql.begin((tx) => tx.unsafe(`SELECT ${WRITE}`))).rejects.toMatchObject({ code: '25006' });
  });

  test('a paren breakout into a second statement is refused by the extended protocol', async () => {
    await expect(evaluateWithoutLexicalCheck(sql, '1)::text; SELECT (1')).rejects.toMatchObject({ code: '42601' });
  });

  test('the claim transaction pins search_path to pg_catalog on its own', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, "current_setting('search_path')")).resolves.toBe('pg_catalog');
  });

  test('the claim transaction cancels a sleeping expression on its own (statement_timeout)', async () => {
    await expect(evaluateWithoutLexicalCheck(plain, 'pg_sleep(30)')).rejects.toMatchObject({ code: '57014' });
  });

  test('the claim transaction is rolled back, so a session change inside it does not outlive it', async () => {
    // set_config(..., is_local => false) survives COMMIT but not ROLLBACK.
    await evaluateWithoutLexicalCheck(sql, "set_config('application_name', 'sql-claim-leak', false)");
    const [row] = await sql`SHOW application_name`;
    expect(row.application_name).not.toBe('sql-claim-leak');
  });

  test('the lexer refuses the same probes before they reach the server', async () => {
    for (const expr of [
      WRITE,
      '1)::text; SELECT (1',
      "current_setting('search_path')",
      'pg_sleep(30)',
      '(SELECT count(*) FROM library)',
    ]) {
      await expect(evaluateClaim(sql, expr)).rejects.toThrow(/not in ALLOWED_FUNCTIONS|unbalanced|not an allowed word/);
    }
  });
});
