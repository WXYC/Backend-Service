/**
 * BS#2699 acceptance: the capped count query's compiled SQL must stay
 * byte-identical to main. The two joins this ticket adds (`rotation`,
 * `library`) exist so the DATA query can select `rotation_bin` /
 * `on_streaming` — they must never reach the count, which is the query with
 * documented timeout history (BS#1681: 12.3s / 500 unbounded).
 *
 * `mainCountQuery` below reconstructs the FROM/WHERE-building shape
 * `search.service.ts` carried on main, byte for byte — `baseFrom`, then the
 * same optional whereClause/cursor appends the old inline `fullWhere` did —
 * and compiles it against the real schema. Comparing that against what
 * `searchFlowsheet` actually sends for the same params is the "byte-identical
 * to main" assertion; using the real schema (not
 * `tests/mocks/database.mock.ts`'s string-sentinel double, which turns every
 * column into a bound parameter) is what makes a dropped/added join clause
 * visible as rendered SQL text rather than invisible to the comparison.
 */
jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const capturedStatements: string[] = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (statement: string) => {
      capturedStatements.push(statement);
      const result = Promise.resolve([]) as Promise<never[]> & { values: () => Promise<never[]> };
      result.values = () => Promise.resolve([]);
      return result;
    },
  };
  return { ...realSchema, db: drizzle({ client }), capturedStatements };
});

import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { flowsheet } from '../../../shared/database/src/schema';
import { searchFlowsheet, parseCursor, COUNT_CAP } from '../../../apps/backend/services/search.service';

const dialect = new PgDialect();
const { capturedStatements } = jest.requireMock<{ capturedStatements: string[] }>('@wxyc/database');

/** Reconstructs main's count query shape, byte for byte, for comparison. */
function mainCountQuery(parsedCursor: ReturnType<typeof parseCursor>, order: 'asc' | 'desc') {
  const baseFrom = sql`
    FROM ${flowsheet}
    WHERE ${flowsheet.entry_type} = 'track'
  `;
  let fullWhere = baseFrom;
  if (parsedCursor) {
    const cmp = order === 'asc' ? sql`>` : sql`<`;
    fullWhere = sql`${fullWhere} AND (${flowsheet.add_time}, ${flowsheet.id}) ${cmp} (${parsedCursor.addTime}::timestamptz, ${parsedCursor.id})`;
  }
  return sql`SELECT COUNT(*)::int AS total FROM (SELECT 1 ${fullWhere} LIMIT ${COUNT_CAP + 1}) AS capped`;
}

describe('count query stays byte-identical to main (BS#2699)', () => {
  it('unfiltered, no cursor', async () => {
    capturedStatements.length = 0;
    await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });
    const [, countStatement] = capturedStatements;

    expect(countStatement).toBe(dialect.sqlToQuery(mainCountQuery(null, 'desc')).sql);
  });

  it('cursor mode', async () => {
    const cursor = '2024-06-16T00:00:00.000Z_999';
    capturedStatements.length = 0;
    await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc', cursor });
    const [, countStatement] = capturedStatements;

    expect(countStatement).toBe(dialect.sqlToQuery(mainCountQuery(parseCursor(cursor), 'desc')).sql);
  });
});
