/**
 * Parser tier of the `sql-claim` runner (WXYC/Backend-Service#2737). The
 * grammar and the read-only layering are documented once, in
 * `tests/utils/sql-claims.js`. This file pins layer 1 (the lexical
 * allowlist) and the block grammar without a database; the layers that need
 * Postgres are pinned in `tests/integration/doc-sql-claims.spec.js`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ClaimSyntaxError,
  assertSafeExpression,
  CLAIM_ROLE,
  collectSqlClaims,
  ensureClaimRole,
  evaluateClaim,
  mentionsSqlClaim,
  parseClaimLine,
  parseSqlClaims,
} from '../../utils/sql-claims';

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'sql-claims');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('assertSafeExpression — hostile inputs are rejected', () => {
  it.each([
    ['statement separator', '1; DROP TABLE x', /statement separator/],
    ['subquery against a table', '(select 1 from library)', /`select` is not an allowed word/],
    ['bare table reference', 'library', /`library` is not an allowed word/],
    ['function outside the allowlist', 'pg_sleep(10)', /function `pg_sleep` is not in ALLOWED_FUNCTIONS/],
    ['write in a scalar position', 'lo_create(0)', /function `lo_create`/],
    ['sequence write', "nextval('s')", /function `nextval`/],
    ['SQL-executing text-search function', "ts_stat('select 1')", /function `ts_stat`/],
    ['SQL-executing ts_rewrite', "ts_rewrite(to_tsquery('a'), 'select 1')", /function `ts_rewrite`/],
    ['session mutation', "set_config('search_path', 'public', false)", /function `set_config`/],
    ['keyword that looks like a call', "coalesce('a', 'b')", /function `coalesce`/],
    ['CAST syntax', "cast('a' as text)", /function `cast`/],
    ['unbalanced close paren', "to_tsquery('simple', 'a'))", /unbalanced `\)`/],
    ['paren breakout into a second statement', '1)::text; SELECT (1', /unbalanced `\)`/],
    ['unbalanced open paren', "to_tsquery('simple', 'a'", /unbalanced `\(`/],
    ['block comment', "to_tsquery(/* x */ 'simple', 'a')", /comment/],
    ['line comment', "to_tsquery('simple', 'a') -- x", /comment/],
    ['unterminated string', "to_tsquery('simple', 'a)", /unterminated string/],
    ['unterminated dollar string', "to_tsquery('simple', $$a)", /unterminated \$\$/],
    ['bind parameter', 'to_tsquery($1)', /only `\$\$…\$\$`/],
    ['tagged dollar quote', "to_tsquery('simple', $x$a$x$)", /only `\$\$…\$\$`/],
    ['identifier glued to $$', "to_tsquery('simple', a$$b$$)", /`\$` inside an identifier/],
    [
      'E-string (backslash escapes a naive lexer misreads)',
      "to_tsquery('simple', E'\\'')",
      /`e` is not an allowed word/,
    ],
    ['Unicode-escape string', "to_tsquery('simple', U&'a')", /`u` is not an allowed word/],
    ['string glued to a number', "to_tsquery('simple', 1'a')", /prefixed or adjacent string literal/],
    [
      'identifier glued to a string',
      "to_tsquery('simple', 'a'b)",
      /identifier character directly after a string literal/,
    ],
    ['quoted identifier', '"pg_sleep"(10)', /quoted identifier/],
    ['schema-qualified function', 'pg_catalog.pg_sleep(10)', /qualified name/],
    ['qualified built-in', "pg_catalog.to_tsquery('a')", /qualified name/],
    ['type outside the allowlist', "'library'::regclass", /type `regclass`/],
    ['type modifier', "'a'::text(10)", /type modifier/],
    ['dangling cast', "'a'::", /must be followed by a type name/],
    ['array constructor', "array['a']", /`array` is not an allowed word|character/],
    ['operator outside the allowlist', "'a' ~ 'b'", /operator `~`/],
    ['glued operator run', "'a' @@@ 'b'", /operator `@@@`/],
    ['non-ASCII outside a literal', "to_tsquery('simple', 'a');", /not allowed/],
    ['empty', '   ', /empty expression/],
  ])('%s: %s', (_label, expr, reason) => {
    expect(() => assertSafeExpression(expr)).toThrow(ClaimSyntaxError);
    expect(() => assertSafeExpression(expr)).toThrow(reason);
  });
});

describe('assertSafeExpression — the shapes docs actually use are accepted', () => {
  it.each([
    "websearch_to_tsquery('simple', '-autechre stereolab')",
    "to_tsquery('simple', $$'-transient':*$$)",
    "to_tsquery('simple', $$'cat\"power':*$$)",
    "to_tsvector('simple', 'Minus 5 -3d World') @@ to_tsquery('simple', $$'-3d':*$$)",
    "setweight(to_tsvector('simple', 'Todd Rundgren'), 'A') || setweight(to_tsvector('simple', 'Angel Hair'), 'B')",
    "ts_delete(to_tsvector('simple', 'a gap b'), 'gap')",
    "ts_rank(to_tsvector('simple', 'cat power'), to_tsquery('simple', 'cat & zzz')) > 0",
    "to_tsquery('simple', $$'d''a':*$$)",
    "'simple'::regconfig",
    'true',
    '1e-20',
    // `not`, `and` and `or` before `(` are keywords, not function calls.
    "not (to_tsvector('simple', 'a') @@ to_tsquery('simple', 'b'))",
    "not(to_tsvector('simple', 'a') @@ to_tsquery('simple', 'b'))",
    "true and (to_tsvector('simple', 'a') @@ to_tsquery('simple', 'a'))",
    "false or (to_tsvector('simple', 'a') @@ to_tsquery('simple', 'a'))",
  ])('%s', (expr) => {
    expect(() => assertSafeExpression(expr)).not.toThrow();
  });
});

describe('parseClaimLine', () => {
  it('splits on ` -> ` and strips a trailing comment from the expected text', () => {
    expect(parseClaimLine("to_tsquery('simple', $$'--foo':*$$)   ->  'foo':*   -- identical to 'foo':*")).toEqual({
      expr: "to_tsquery('simple', $$'--foo':*$$)",
      expected: "'foo':*",
    });
  });

  it('does not treat `<->` in the expected text as a separator, or `--` inside a quoted lexeme as a comment', () => {
    expect(parseClaimLine("to_tsquery('simple', $$'-3d':*$$)  ->  '-3':* <-> 'd':*")).toEqual({
      expr: "to_tsquery('simple', $$'-3d':*$$)",
      expected: "'-3':* <-> 'd':*",
    });
    expect(parseClaimLine("to_tsquery('simple', $$'x':*$$)  ->  '--x':*").expected).toBe("'--x':*");
  });

  it('does not find a separator inside a literal of the expression', () => {
    expect(parseClaimLine("to_tsquery('simple', $$'a -> b'$$)  ->  'a' <-> 'b'").expr).toBe(
      "to_tsquery('simple', $$'a -> b'$$)"
    );
  });

  it.each([
    ['no separator', "to_tsquery('simple', 'a')", /no ` -> ` separator/],
    ['empty expected', "to_tsquery('simple', 'a')  ->    -- nothing", /empty expected text/],
    ['two separators', "to_tsquery('simple', 'a')  ->  'a'  ->  'b'", /more than one/],
    ['hostile expression', 'pg_sleep(10)  ->  x', /pg_sleep/],
  ])('rejects %s', (_label, line, reason) => {
    expect(() => parseClaimLine(line)).toThrow(reason);
  });
});

describe('parseSqlClaims — block grammar', () => {
  it('parses the valid fixture and ignores a plain `sql` block', () => {
    const { claims, errors } = parseSqlClaims(fixture('valid.md'), 'valid.md');
    expect(errors).toEqual([]);
    expect(claims).toEqual([
      { file: 'valid.md', line: 4, expr: "to_tsquery('simple', $$'-3d':*$$)", expected: "'-3':* <-> 'd':*" },
      {
        file: 'valid.md',
        line: 5,
        expr: "to_tsvector('simple', 'Minus 5 -3d World') @@ to_tsquery('simple', $$'3d':*$$)",
        expected: 'false',
      },
    ]);
  });

  it('rejects every line of the hostile fixture by file:line and yields no claim to execute', () => {
    const { claims, errors } = parseSqlClaims(fixture('hostile.md'), 'hostile.md');
    expect(claims).toEqual([]);
    expect(errors.map((e) => `${e.file}:${e.line}`)).toEqual([
      // Having no valid line, the block itself is empty (errors are sorted by line).
      'hostile.md:5',
      'hostile.md:6',
      'hostile.md:7',
      'hostile.md:8',
      'hostile.md:9',
      'hostile.md:10',
      'hostile.md:11',
    ]);
  });

  it('fails a block with zero claims, naming the fence line', () => {
    expect(parseSqlClaims(fixture('zero-claims.md'), 'zero-claims.md')).toEqual({
      claims: [],
      errors: [{ file: 'zero-claims.md', line: 5, message: 'sql-claim block contains zero claims' }],
    });
  });

  it.each([
    ['plural info string', '```sql-claims\na  ->  b\n```'],
    ['upper-case info string', '```SQL-claim\na  ->  b\n```'],
    ['trailing info text', '```sql-claim extra\na  ->  b\n```'],
    ['indented fence', '  ```sql-claim\na  ->  b\n  ```'],
    ['tilde fence', '~~~sql-claim\na  ->  b\n~~~'],
    ['four-backtick fence', '````sql-claim\na  ->  b\n````'],
  ])('fails a near-miss fence (%s) rather than skipping it', (_label, text) => {
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(claims).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ file: 'doc.md', line: 1, message: expect.stringMatching(/malformed sql-claim fence/) }),
    ]);
  });

  it('fails an unclosed block', () => {
    expect(parseSqlClaims("x\n```sql-claim\n'a'  ->  a\n", 'doc.md').errors).toEqual([
      { file: 'doc.md', line: 2, message: 'unclosed sql-claim block' },
    ]);
  });

  it('fails a sql-claim fence quoted inside another code block instead of ignoring it', () => {
    const text = '````markdown\n```sql-claim\npg_sleep(10)  ->  x\n```\n````\n';
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(claims).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ line: 2, message: expect.stringMatching(/inside the code block opened at line 1/) }),
    ]);
  });

  it('collects across a directory with stable ordering and file labels', () => {
    const { claims, errors } = collectSqlClaims(FIXTURES, (p: string) => p.slice(FIXTURES.length + 1));
    expect(claims.map((c: { file: string; line: number }) => `${c.file}:${c.line}`)).toEqual([
      'valid.md:4',
      'valid.md:5',
    ]);
    expect(new Set(errors.map((e: { file: string }) => e.file))).toEqual(new Set(['hostile.md', 'zero-claims.md']));
  });
});

/**
 * Round-1 review (PR #2746): each of these shapes made a whole block vanish.
 * Before the fix, parseSqlClaims returned `{ claims: [], errors: [] }` for
 * every case below except the indented closer, which returned the first claim
 * and silently dropped the rest. Each must now be loud, naming file:line.
 */
describe('parseSqlClaims — shapes that used to skip a block silently', () => {
  const HOSTILE = 'pg_sleep(10)  ->  x';
  const VALID = "'a'::text  ->  a";

  it('reads CRLF line endings, so a CRLF block is parsed and its hostile line rejected', () => {
    const hostile = parseSqlClaims(`intro\r\n\`\`\`sql-claim\r\n${HOSTILE}\r\n\`\`\`\r\n`, 'doc.md');
    expect(hostile.claims).toEqual([]);
    expect(hostile.errors.map((e) => e.line)).toEqual([2, 3]);
    const valid = parseSqlClaims(`\`\`\`sql-claim\r\n${VALID}\r\n\`\`\`\r\n`, 'doc.md');
    expect(valid).toEqual({ claims: [{ file: 'doc.md', line: 2, expr: "'a'::text", expected: 'a' }], errors: [] });
  });

  it.each([
    ['in a blockquote', `> \`\`\`sql-claim\n> ${VALID}\n> \`\`\`\n`],
    ['on a list-item line', `- \`\`\`sql-claim\n  ${VALID}\n  \`\`\`\n`],
    ['with a braced info string', `\`\`\`{sql-claim}\n${VALID}\n\`\`\`\n`],
    ['with a Unicode hyphen', `\`\`\`sql\u2010claim\n${VALID}\n\`\`\`\n`],
    ['with an attribute-style info string', `\`\`\`{.sql .claim}\n${VALID}\n\`\`\`\n`],
  ])('fails a sql-claim opener %s', (_label, text) => {
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(claims).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ file: 'doc.md', line: 1 })]);
  });

  it('fails a sql-claim opener swallowed by an earlier unclosed plain fence', () => {
    const text = `\`\`\`\nforgot to close this\n\n\`\`\`sql-claim\n${HOSTILE}\n\`\`\`\n`;
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(claims).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ line: 4, message: expect.stringMatching(/inside the code block opened at line 1/) }),
    ]);
  });

  it('does not treat a closing fence indented four spaces as a closer (CommonMark: it is content)', () => {
    const text = `\`\`\`sql-claim\n${VALID}\n    \`\`\`\n'b'::text  ->  b\n\`\`\`\n`;
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(claims.map((c) => c.line)).toEqual([2, 4]);
    expect(errors).toEqual([
      expect.objectContaining({ line: 3, message: expect.stringMatching(/no ` -> ` separator/) }),
    ]);
  });

  it('accepts a closing fence indented up to three spaces', () => {
    expect(parseSqlClaims(`\`\`\`sql-claim\n${VALID}\n   \`\`\`\n`, 'doc.md').errors).toEqual([]);
  });

  it('still ignores plain fences, closed or not, that hold no sql-claim opener', () => {
    expect(parseSqlClaims('```sql\nSELECT 1; -- -> x\n```\n\n```\nunclosed\n', 'doc.md')).toEqual({
      claims: [],
      errors: [],
    });
  });
});

/**
 * Round-2 review (PR #2746). The claim role only bounds a lexer bypass that
 * cannot also re-escalate, so layer 1 must refuse every way an expression can
 * change the current role or session user, or read one.
 */
describe('assertSafeExpression — re-escalation is refused by the lexer', () => {
  it.each([
    "set_config('role', 'postgres', true)",
    "set_config('session_authorization', 'postgres', true)",
    "set_config('role', 'postgres', true) || to_tsquery('simple', 'a')",
    "current_setting('role')",
    "current_setting('is_superuser')",
    "query_to_xml('select 1', false, false, '')",
    'pg_terminate_backend(1)',
    "pg_read_file('PG_VERSION')",
  ])('rejects the call %s', (expr) => {
    expect(() => assertSafeExpression(expr)).toThrow(/is not in ALLOWED_FUNCTIONS/);
  });

  it.each(['current_user', 'session_user', 'current_role', 'reset', 'role', "'postgres'::regrole"])(
    'rejects the word or cast %s',
    (expr) => {
      expect(() => assertSafeExpression(expr)).toThrow(/not an allowed word|type `regrole`/);
    }
  );
});

describe('parseSqlClaims — prose that mentions a fence is not an opener (round 2)', () => {
  it.each([
    ['inline code mid-sentence', 'Claims are written as ` ```sql-claim ` blocks, one per line.'],
    ['a fence named mid-sentence', 'Demoting a block to a plain ```sql fence drops the claim silently.'],
    ['a tilde run mid-sentence', 'Use ~~~ for strikethrough in sql prose and claim nothing.'],
    ['inline code at the start of a line', '` ```sql-claim ` is the opener.'],
  ])('%s', (_label, line) => {
    expect(parseSqlClaims(`intro\n${line}\n`, 'doc.md')).toEqual({ claims: [], errors: [] });
    expect(mentionsSqlClaim(line)).toBe(false);
  });

  it('reports a fence-like line inside a claim block once, as a bad claim line, not also as an opener', () => {
    const { errors } = parseSqlClaims("```sql-claim\n'a'::text  ->  a\n~~~sql-claim\n```\n", 'doc.md');
    expect(errors).toEqual([
      expect.objectContaining({ line: 3, message: expect.stringMatching(/no ` -> ` separator/) }),
    ]);
  });

  it('does not scan the lines of a consumed claim block for openers', () => {
    const text = "```sql-claim\nto_tsquery('simple', $$'x'$$)  ->  'x'   -- see ~~~sql-claim\n```\n";
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(errors).toEqual([]);
    expect(claims).toHaveLength(1);
  });
});

describe('parseSqlClaims — malformed openers still fail (round 2)', () => {
  it.each([
    ['three-space indent', "   ```sql-claim\n'a'::text  ->  a\n   ```\n"],
    ['nested blockquote', "> > ```sql-claim\n> > 'a'::text  ->  a\n> > ```\n"],
    ['ordered-list item', "1. ```sql-claim\n   'a'::text  ->  a\n   ```\n"],
    ['star list item with tilde fence', "* ~~~sql-claim\n  'a'::text  ->  a\n  ~~~\n"],
    ['zero-width space inside the info string', "```s​ql-claim\n'a'::text  ->  a\n```\n"],
    ['zero-width joiner after the info string', "```sql-claim‍\n'a'::text  ->  a\n```\n"],
  ])('%s', (_label, text) => {
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(claims).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ line: 1, message: expect.stringMatching(/malformed sql-claim fence/) }),
    ]);
    expect(mentionsSqlClaim(text)).toBe(true);
  });

  it.each([
    ['backtick fence', "```\nsql-claim\n'a'::text  ->  a\n```\n"],
    ['tilde fence, mixed case', "~~~\nSQL-Claim\n'a'::text  ->  a\n~~~\n"],
  ])('fails a plain %s whose first content line is the info string', (_label, text) => {
    const { claims, errors } = parseSqlClaims(text, 'doc.md');
    expect(claims).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ line: 2, message: expect.stringMatching(/info string must be on the fence line/) }),
    ]);
    expect(mentionsSqlClaim(text)).toBe(true);
  });
});

describe('evaluateClaim — the lexical check runs before the database is touched', () => {
  it.each([
    '1; DROP TABLE x',
    '(select 1 from library)',
    'pg_sleep(10)',
    "to_tsquery('simple', 'a'))",
    "to_tsquery(/* x */ 'a')",
  ])('%s never reaches the connection', async (expr) => {
    const sql = { begin: jest.fn(), unsafe: jest.fn() };
    await expect(evaluateClaim(sql, expr)).rejects.toThrow(ClaimSyntaxError);
    expect(sql.begin).not.toHaveBeenCalled();
    expect(sql.unsafe).not.toHaveBeenCalled();
  });
});

describe('ensureClaimRole — idempotent create-or-alter (round 2)', () => {
  const pgError = (code: string, message = code) => Object.assign(new Error(message), { code });
  const fakeSql = (createError?: Error, alterError?: Error) => ({
    unsafe: jest.fn((q: string) => {
      if (q.startsWith('CREATE ROLE') && createError) return Promise.reject(createError);
      if (q.startsWith('ALTER ROLE') && alterError) return Promise.reject(alterError);
      return Promise.resolve([]);
    }),
  });

  it('creates a non-superuser LOGIN role and returns its credentials', async () => {
    const sql = fakeSql();
    const creds = await ensureClaimRole(sql);
    expect(creds).toEqual({ user: CLAIM_ROLE, password: expect.stringMatching(/^[0-9a-f]{48}$/) });
    expect(sql.unsafe.mock.calls[0][0]).toMatch(
      new RegExp(
        `^CREATE ROLE ${CLAIM_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '[0-9a-f]{48}'$`
      )
    );
  });

  it.each([
    ['42710 (the other creator committed first)', '42710'],
    ['23505 on pg_authid_rolname_index (the other creator committed while we waited)', '23505'],
  ])('treats %s as "exists" and re-asserts the attributes', async (_label, code) => {
    const sql = fakeSql(pgError(code));
    const first = await ensureClaimRole(sql);
    expect(sql.unsafe.mock.calls.map((c: string[]) => c[0].split(' ').slice(0, 2).join(' '))).toEqual([
      'CREATE ROLE',
      'ALTER ROLE',
    ]);
    expect(await ensureClaimRole(fakeSql(pgError(code)))).toEqual(first);
  });

  it('says what the DB user lacks when it cannot create or alter the role (42501)', async () => {
    await expect(ensureClaimRole(fakeSql(pgError('42501', 'permission denied to create role')))).rejects.toThrow(
      /cannot create or alter wxyc_sql_claim_reader \(permission denied to create role\); it needs to be a superuser/
    );
    await expect(ensureClaimRole(fakeSql(pgError('42710'), pgError('42501', 'denied')))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('rethrows any other error unchanged', async () => {
    await expect(ensureClaimRole(fakeSql(pgError('08006', 'connection failure')))).rejects.toThrow(
      /^connection failure$/
    );
  });
});
