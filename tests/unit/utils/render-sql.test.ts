/**
 * Unit tests for the canonical SQL renderer (tests/utils/render-sql.ts,
 * BS#2051), which renders the four chunk shapes the manual drizzle-orm mock
 * (tests/__mocks__/drizzle-orm.ts) can hand to `db.execute(...)`:
 * `{ sql, values }`, `{ raw }`, `{ join, sep }`, and `{ queryChunks }`.
 *
 * The `{ join, sep }` coverage below is a direct regression test for the
 * PR #2041 failure mode: a local renderer with no case for that shape
 * silently rendered an empty string instead of throwing, and the resulting
 * assertion failure (`FROM (VALUES )`) pointed nowhere near the real bug.
 */
import { renderSql, renderValue } from '../../utils/render-sql';
import { sql } from '../../__mocks__/drizzle-orm';

describe('renderSql — {sql, values} tagged-template chunks', () => {
  it('renders fragments with interpolated primitive values', () => {
    const chunk = { sql: ['SELECT * FROM t WHERE id = ', ' AND name = ', ''], values: [42, 'Stereolab'] };
    expect(renderSql(chunk)).toBe('SELECT * FROM t WHERE id = 42 AND name = Stereolab');
  });

  it('renders a chunk with no interpolated values', () => {
    expect(renderSql({ sql: ['SELECT 1'], values: [] })).toBe('SELECT 1');
  });

  it('renders null-valued interpolations as an empty string (a bound SQL NULL)', () => {
    expect(renderSql({ sql: ['x = ', ''], values: [null] })).toBe('x = ');
  });

  it('recurses into a nested {sql, values} chunk used as an interpolated value', () => {
    const inner = { sql: ['a = ', ''], values: [1] };
    const outer = { sql: ['WHERE ', ' AND b = 2'], values: [inner] };
    expect(renderSql(outer)).toBe('WHERE a = 1 AND b = 2');
  });
});

describe('renderSql — {raw} chunks (sql.raw)', () => {
  it('renders the raw string verbatim', () => {
    expect(renderSql({ raw: '"wxyc_schema"."library_identity"' })).toBe('"wxyc_schema"."library_identity"');
  });

  it('renders a {raw} chunk used as an interpolated value inside a {sql, values} chunk', () => {
    const table = { raw: '"wxyc_schema"."library"' };
    const chunk = { sql: ['UPDATE ', ' SET x = 1'], values: [table] };
    expect(renderSql(chunk)).toBe('UPDATE "wxyc_schema"."library" SET x = 1');
  });
});

describe('renderSql — {join, sep} chunks (sql.join) — PR #2041 regression coverage', () => {
  it('joins rendered {sql, values} fragments with a rendered {sql, values} separator', () => {
    const fragments = [
      { sql: ['(', ', ', ')'], values: [1, 'a'] },
      { sql: ['(', ', ', ')'], values: [2, 'b'] },
    ];
    const sep = { sql: [', '], values: [] };
    expect(renderSql({ join: fragments, sep })).toBe('(1, a), (2, b)');
  });

  it('joins fragments with a {raw} separator', () => {
    const fragments = [{ raw: 'a = 1' }, { raw: 'b = 2' }];
    expect(renderSql({ join: fragments, sep: { raw: ' OR ' } })).toBe('a = 1 OR b = 2');
  });

  it('never renders an empty body: a {join, sep} chunk with non-empty fragments must not collapse to the empty string', () => {
    // This is the exact shape of the PR #2041 bug: a renderer with no
    // {join, sep} case fell through its default branch and produced ''
    // here, which surfaced downstream as `FROM (VALUES )`.
    const fragments = [{ raw: "'A'" }, { raw: "'B'" }];
    const rendered = renderSql({ join: fragments, sep: { sql: [', '], values: [] } });
    expect(rendered).not.toBe('');
    expect(rendered).toBe("'A', 'B'");
  });

  it('treats an undefined separator as no separator at all (matches sql.join called without one)', () => {
    expect(renderSql({ join: [{ raw: 'a' }, { raw: 'b' }], sep: undefined })).toBe('ab');
  });

  it('renders a {join, sep} chunk used as an interpolated value inside a {sql, values} chunk (the FROM (VALUES ...) shape)', () => {
    const rows = [
      { sql: ['(', ', ', ')'], values: [1, 'a'] },
      { sql: ['(', ', ', ')'], values: [2, 'b'] },
    ];
    const joined = { join: rows, sep: { sql: [', '], values: [] } };
    const query = { sql: ['SELECT * FROM (VALUES ', ') AS v(id, name)'], values: [joined] };
    expect(renderSql(query)).toBe('SELECT * FROM (VALUES (1, a), (2, b)) AS v(id, name)');
  });
});

describe('renderSql — {queryChunks} fragments (real drizzle-orm leaking through)', () => {
  it('joins string chunks and {value} chunks', () => {
    const chunk = { queryChunks: ['SELECT ', { value: ['1'] }, ' AS one'] };
    expect(renderSql(chunk)).toBe('SELECT 1 AS one');
  });

  it('renders a {value} chunk whose value is a plain string', () => {
    const chunk = { queryChunks: ['x = ', { value: 'y' }] };
    expect(renderSql(chunk)).toBe('x = y');
  });

  it('recurses into a nested queryChunks fragment', () => {
    const inner = { queryChunks: ['a = ', { value: ['1'] }] };
    const outer = { queryChunks: ['WHERE ', inner] };
    expect(renderSql(outer)).toBe('WHERE a = 1');
  });
});

describe('renderSql — unrecognized shapes throw loudly instead of rendering empty', () => {
  it('throws for an object matching none of the four known shapes, serializing the offending value', () => {
    const bogus = { totallyUnknownField: 'mystery-value' };
    expect(() => renderSql(bogus)).toThrow(/totallyUnknownField/);
    expect(() => renderSql(bogus)).toThrow(/mystery-value/);
  });

  it('throws for a null top-level chunk rather than returning an empty string', () => {
    expect(() => renderSql(null)).toThrow(/unrecognized SQL mock shape/);
  });

  it('throws for an undefined top-level chunk rather than returning an empty string', () => {
    expect(() => renderSql(undefined)).toThrow(/unrecognized SQL mock shape/);
  });

  it('throws for a bare primitive where a SQL chunk object was expected', () => {
    expect(() => renderSql(42)).toThrow(/unrecognized SQL mock shape/);
  });

  it('throws for an unrecognized separator shape nested inside an otherwise-valid {join, sep} chunk', () => {
    const fragments = [{ raw: 'a' }, { raw: 'b' }];
    expect(() => renderSql({ join: fragments, sep: { mystery: true } })).toThrow(/mystery/);
  });
});

describe('renderValue — bound SQL parameter values', () => {
  it('renders null and undefined as an empty string (a bound SQL NULL)', () => {
    expect(renderValue(null)).toBe('');
    expect(renderValue(undefined)).toBe('');
  });

  it('stringifies primitive values', () => {
    expect(renderValue(42)).toBe('42');
    expect(renderValue('Stereolab')).toBe('Stereolab');
    expect(renderValue(true)).toBe('true');
    expect(renderValue(false)).toBe('false');
  });

  it('delegates a nested SQL-chunk-shaped value to renderSql', () => {
    expect(renderValue({ raw: 'NOW()' })).toBe('NOW()');
    expect(renderValue({ sql: ['x'], values: [] })).toBe('x');
    expect(renderValue({ join: [{ raw: 'a' }], sep: undefined })).toBe('a');
  });

  it('renders an interpolated mock schema table as an empty string', () => {
    // `tests/mocks/database.mock.ts` models every table as `{ column:
    // 'column' }` (or `{}`), so `` sql`FROM ${flowsheet} f` `` carries a table
    // *reference* with no name to render. Jobs that interpolate tables rather
    // than naming them via `sql.raw` (e.g. jobs/legacy-linkage-resolve) hit
    // this on every statement.
    expect(renderValue({ id: 'id', album_id: 'album_id' })).toBe('');
    expect(renderValue({})).toBe('');
  });

  it('still throws on a bound object that is not a mock table', () => {
    // The key-equals-value test is what separates the two: a JSONB param or
    // any other genuine object value must not be silently swallowed.
    expect(() => renderValue({ id: 'not-the-key' })).toThrow(/not-the-key/);
  });

  it('throws with the offending value serialized for an unrecognized shape', () => {
    const bogus = { mystery: true };
    expect(() => renderValue(bogus)).toThrow(/mystery/);
  });
});

describe('renderSql — against the shared drizzle-orm mock (tests/__mocks__/drizzle-orm.ts)', () => {
  it('renders sql`...` tagged-template output produced by the real mock function', () => {
    const id = 42;
    expect(renderSql(sql`SELECT * FROM t WHERE id = ${id}`)).toBe('SELECT * FROM t WHERE id = 42');
  });

  it('renders sql.raw(...) output produced by the real mock function', () => {
    expect(renderSql(sql.raw('"wxyc_schema"."library_identity"'))).toBe('"wxyc_schema"."library_identity"');
  });

  it('renders sql.join(...) output produced by the real mock function — the exact shape PR #2041 broke on', () => {
    const rows = [sql`(${1}, ${'a'})`, sql`(${2}, ${'b'})`];
    const joined = sql.join(rows, sql`, `);
    expect(renderSql(joined)).toBe('(1, a), (2, b)');
  });
});
