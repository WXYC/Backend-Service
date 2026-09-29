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
  collectSqlClaims,
  evaluateClaim,
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
      'hostile.md:6',
      'hostile.md:7',
      'hostile.md:8',
      'hostile.md:9',
      'hostile.md:10',
      'hostile.md:11',
      // ...and, having no valid line, the block itself is empty.
      'hostile.md:5',
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

  it('ignores a sql-claim fence quoted inside another code block', () => {
    const text = '````markdown\n```sql-claim\npg_sleep(10)  ->  x\n```\n````\n';
    expect(parseSqlClaims(text, 'doc.md')).toEqual({ claims: [], errors: [] });
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
