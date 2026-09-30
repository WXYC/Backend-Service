/**
 * Qualification invariant (BS#2699). Every SORT_MAP / COLUMN_MAP reference in
 * search.service.ts must stay `${flowsheet.x}`-qualified. The two joins this
 * ticket adds shadow three of those columns — `rotation` and `library` both
 * carry `artist_name`/`album_title`, and `rotation` also carries
 * `record_label` — so an unqualified reference that worked fine on the old
 * single-table query becomes an ambiguous-column error the moment either join
 * lands.
 *
 * This compiles the real schema, not `tests/mocks/database.mock.ts`'s
 * string-sentinel double: under that double every column reference renders as
 * a bound parameter (`$n`), not as SQL text, so a dropped table qualifier
 * would be invisible to a test built on it. Mirrors
 * `flowsheet.rotationBin.sql.test.ts`'s real-schema capture harness.
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

import { searchFlowsheet } from '../../../apps/backend/services/search.service';
import type { SearchParams } from '../../../apps/backend/services/search.service';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const { capturedStatements } = jest.requireMock<{ capturedStatements: string[] }>('@wxyc/database');

async function dataStatement(run: () => Promise<unknown>): Promise<string> {
  capturedStatements.length = 0;
  await run();
  return capturedStatements[0];
}

describe('SORT_MAP renders every sort column table-qualified (BS#2699)', () => {
  it.each<[SearchParams['sort'], string]>([
    ['date', `"${SCHEMA}"."flowsheet"."add_time"`],
    ['artist', `"${SCHEMA}"."flowsheet"."artist_name"`],
    ['song', `"${SCHEMA}"."flowsheet"."track_title"`],
    ['dj', `"${SCHEMA}"."flowsheet"."dj_name"`],
  ])('sort=%s orders by %s', async (sort, qualified) => {
    const statement = await dataStatement(() => searchFlowsheet({ q: '', page: 0, limit: 50, sort, order: 'desc' }));
    expect(statement).toContain(`ORDER BY ${qualified}`);
  });
});

describe('COLUMN_MAP renders every filterable field table-qualified (BS#2699)', () => {
  it.each([
    ['artist:', 'artist_name'],
    ['song:', 'track_title'],
    ['album:', 'album_title'],
    ['label:', 'record_label'],
  ])('%s -> %s', async (prefix, column) => {
    const statement = await dataStatement(() =>
      searchFlowsheet({ q: `${prefix}probe`, page: 0, limit: 50, sort: 'date', order: 'desc' })
    );
    expect(statement).toContain(`"${SCHEMA}"."flowsheet"."${column}"`);
  });
});
