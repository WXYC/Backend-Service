// The unit suite auto-mocks drizzle-orm (tests/__mocks__/drizzle-orm.ts) so
// `sql` returns a plain `{ sql, values }` shape. This suite needs the real
// tag + dialect to compile fragments and inspect the escaped patterns/ESCAPE
// clause the helper emits.
jest.unmock('drizzle-orm');

import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { escapeLikePattern, ilikeEscaped } from '../../../apps/backend/utils/sql-like';

const dialect = new PgDialect();

describe('escapeLikePattern', () => {
  it('escapes a literal percent so it cannot act as a wildcard', () => {
    // "100%" is a real track title; without escaping it matches "100" + anything.
    expect(escapeLikePattern('100%')).toBe('100\\%');
  });

  it('escapes a literal underscore so it cannot act as a single-char wildcard', () => {
    // "Hot_Soup" is a real band name; "_" would otherwise match any character.
    expect(escapeLikePattern('Hot_Soup')).toBe('Hot\\_Soup');
  });

  it('escapes the backslash escape character itself', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('escapes the backslash before the wildcard it precedes (ordering matters)', () => {
    // Raw input "\%" must become "\\" + "\%" = "\\\%", never "\\%" (which would
    // re-introduce an active wildcard after a single escaped backslash).
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('leaves ordinary (including diacritic-bearing) text untouched', () => {
    expect(escapeLikePattern('Nilüfer Yanya')).toBe('Nilüfer Yanya');
  });
});

describe('ilikeEscaped', () => {
  it('emits an explicit ESCAPE clause', () => {
    const { sql: text } = dialect.sqlToQuery(ilikeEscaped(sql`x`, 'a%'));
    expect(text).toContain("ESCAPE '\\'");
  });

  it("defaults to a substring ('contains') pattern with the value escaped", () => {
    const { params } = dialect.sqlToQuery(ilikeEscaped(sql`x`, '100%'));
    // %  + escaped("100%") + %  =>  %100\%%
    expect(params).toContain('%100\\%%');
  });

  it('prefix wrap appends only a trailing wildcard', () => {
    const { params } = dialect.sqlToQuery(ilikeEscaped(sql`x`, 'a%', 'prefix'));
    expect(params).toContain('a\\%%');
  });

  it('suffix wrap prepends only a leading wildcard', () => {
    const { params } = dialect.sqlToQuery(ilikeEscaped(sql`x`, 'a%', 'suffix'));
    expect(params).toContain('%a\\%');
  });

  it('exact wrap adds no wildcards but still escapes user metacharacters', () => {
    const { params } = dialect.sqlToQuery(ilikeEscaped(sql`x`, 'AC_DC', 'exact'));
    expect(params).toContain('AC\\_DC');
  });
});
