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
 *
 * Also covers three invariants adjacent to qualification, on the same
 * harness: that `id` and `search_doc` (ambiguous once the joins land, same as
 * SORT_MAP/COLUMN_MAP's columns, but referenced directly rather than through
 * either map) stay qualified everywhere they're used — the cursor predicate,
 * the ORDER BY tiebreaker, and both arms of the all-field match; that the
 * data and count statements' WHERE predicates never diverge except by the
 * join lines between them; and that the `library` join and its
 * `request_flag`/`on_streaming` projection render as intended.
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

/** Like {@link dataStatement}, but returns both statements `searchFlowsheet` issues. */
async function statementsOf(run: () => Promise<unknown>): Promise<[string, string]> {
  capturedStatements.length = 0;
  await run();
  return [capturedStatements[0], capturedStatements[1]];
}

const OUTER_WHERE_ANCHOR = `WHERE "${SCHEMA}"."flowsheet"."entry_type" = 'track'`;

/**
 * The outer WHERE predicate, from the `entry_type = 'track'` anchor through
 * (but excluding) whichever of `ORDER BY` / `LIMIT` terminates it first.
 * `entry_type = 'track'` is unique to the outer clause — every other `WHERE`
 * in either statement sits inside `rotationBinExpr`'s fallback subquery,
 * entirely above this anchor in the data statement's SELECT list — so this
 * never latches onto the wrong `WHERE`. The result is trimmed because the
 * data and count templates carry different, meaningless trailing whitespace
 * at this point (the data query's own newline before `ORDER BY` vs. the count
 * query's single space before `LIMIT`).
 */
function outerWhereClause(statement: string): string {
  const start = statement.indexOf(OUTER_WHERE_ANCHOR);
  if (start === -1) throw new Error(`outer WHERE anchor not found in statement:\n${statement}`);
  const rest = statement.slice(start);
  const stop = rest.search(/\bORDER BY\b|\bLIMIT\b/);
  return (stop === -1 ? rest : rest.slice(0, stop)).trim();
}

/**
 * The outer ORDER BY clause. `lastIndexOf` because `rotationBinExpr`'s
 * fallback subquery has its own `ORDER BY t.id`, ahead of the outer one, in
 * the data statement's SELECT list.
 */
function outerOrderByClause(statement: string): string {
  const start = statement.lastIndexOf('ORDER BY');
  if (start === -1) throw new Error(`outer ORDER BY not found in statement:\n${statement}`);
  const rest = statement.slice(start);
  const stop = rest.search(/\bLIMIT\b/);
  return (stop === -1 ? rest : rest.slice(0, stop)).trim();
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
    // The SELECT list (and rotationBinExpr's fallback) already carries a
    // qualified reference to every one of these columns regardless of
    // COLUMN_MAP, so asserting against the whole statement can never fail —
    // a COLUMN_MAP entry rewritten to a bare column name still finds its
    // qualified twin elsewhere in the same statement. `ILIKE` appears nowhere
    // in this statement except the predicate COLUMN_MAP builds, so anchoring
    // the qualified name directly ahead of it targets that predicate and
    // nothing else.
    expect(statement).toContain(`"${SCHEMA}"."flowsheet"."${column}" ILIKE`);
  });
});

describe('data and count predicates are identical modulo the join clause (BS#2699)', () => {
  it.each<[string, SearchParams]>([
    ['unfiltered, no cursor', { q: '', page: 0, limit: 50, sort: 'date', order: 'desc' }],
    ['text-filtered', { q: 'artist:probe', page: 0, limit: 50, sort: 'date', order: 'desc' }],
    ['cursor', { q: '', page: 0, limit: 50, sort: 'date', order: 'desc', cursor: '2024-06-16T00:00:00.000Z_999' }],
  ])('%s: the data WHERE matches the count WHERE once the join lines are stripped', async (_name, params) => {
    const [dataStmt, countStmt] = await statementsOf(() => searchFlowsheet(params));
    expect(outerWhereClause(dataStmt)).toBe(outerWhereClause(countStmt));
  });
});

describe('other ambiguous column references stay qualified (BS#2699)', () => {
  const ID = `"${SCHEMA}"."flowsheet"."id"`;
  const ADD_TIME = `"${SCHEMA}"."flowsheet"."add_time"`;
  const SEARCH_DOC = `"${SCHEMA}"."flowsheet"."search_doc"`;
  const ARTIST = `"${SCHEMA}"."flowsheet"."artist_name"`;
  const TRACK = `"${SCHEMA}"."flowsheet"."track_title"`;
  const ALBUM = `"${SCHEMA}"."flowsheet"."album_title"`;
  const LABEL = `"${SCHEMA}"."flowsheet"."record_label"`;

  it('the cursor predicate compares a qualified (add_time, id) tuple', async () => {
    const statement = await dataStatement(() =>
      searchFlowsheet({
        q: '',
        page: 0,
        limit: 50,
        sort: 'date',
        order: 'desc',
        cursor: '2024-06-16T00:00:00.000Z_999',
      })
    );
    expect(outerWhereClause(statement)).toContain(`(${ADD_TIME}, ${ID}) <`);
  });

  it('the date-sort ORDER BY tiebreaker is a qualified id', async () => {
    const statement = await dataStatement(() =>
      searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' })
    );
    expect(outerOrderByClause(statement)).toContain(`, ${ID} DESC`);
  });

  it('the tsvector arm of the all-field match reads a qualified search_doc', async () => {
    // 3+ alphanumeric characters with no field prefix routes to the tsvector
    // branch — see shouldUseTsvector. `dataStatement` returns the FIRST
    // statement issued, which is always the 'word' tier's data query
    // (WXYC/Backend-Service#2712's cascade tries 'word' first, and its SQL
    // is byte-identical to pre-#2712 `main` — the 'prefix' tier's own CASE
    // form is covered separately, in search.service.cascade.test.ts).
    const statement = await dataStatement(() =>
      searchFlowsheet({ q: 'probe', page: 0, limit: 50, sort: 'date', order: 'desc' })
    );
    expect(outerWhereClause(statement)).toContain(`${SEARCH_DOC} @@ to_tsquery`);
  });

  it("the seam guard's gapped rebuild reads all five columns qualified (BS#2726)", async () => {
    // `library` also has an `artist_name`, and BS#2699 joins it into this
    // query, so an unqualified column inside the gapped vector would be
    // ambiguous. An apostrophe token makes the guard's gapped arm render.
    const statement = await dataStatement(() =>
      searchFlowsheet({ q: "o'rourke", page: 0, limit: 50, sort: 'date', order: 'desc' })
    );
    const where = outerWhereClause(statement);
    const DJ = `"${SCHEMA}"."flowsheet"."dj_name"`;
    for (const column of [ARTIST, TRACK, DJ, ALBUM, LABEL]) {
      expect(where).toContain(`coalesce(${column}, '')`);
    }
    expect(where).not.toMatch(/coalesce\("(artist_name|track_title|dj_name|album_title|record_label)"/);
  });

  it('the quoted-exact arm of the all-field match qualifies all four columns', async () => {
    const statement = await dataStatement(() =>
      searchFlowsheet({ q: '"probe"', page: 0, limit: 50, sort: 'date', order: 'desc' })
    );
    const where = outerWhereClause(statement);
    expect(where).toContain(`${ARTIST} ILIKE`);
    expect(where).toContain(`${TRACK} ILIKE`);
    expect(where).toContain(`${ALBUM} ILIKE`);
    expect(where).toContain(`${LABEL} ILIKE`);
  });

  it('the trigram-fallback arm of the all-field match qualifies all four columns', async () => {
    // Below the 3-character tsvector floor, so it routes to the trigram arm.
    const statement = await dataStatement(() =>
      searchFlowsheet({ q: 'pr', page: 0, limit: 50, sort: 'date', order: 'desc' })
    );
    const where = outerWhereClause(statement);
    expect(where).toContain(`${ARTIST} ILIKE`);
    expect(where).toContain(`${TRACK} ILIKE`);
    expect(where).toContain(`${ALBUM} ILIKE`);
    expect(where).toContain(`${LABEL} ILIKE`);
  });
});

describe('library join and its projected columns stay pinned (BS#2699)', () => {
  const LIBRARY_JOIN = `LEFT JOIN "${SCHEMA}"."library" ON "${SCHEMA}"."library"."id" = "${SCHEMA}"."flowsheet"."album_id"`;

  it('joins library on flowsheet.album_id and projects request_flag / on_streaming from the right tables', async () => {
    const statement = await dataStatement(() =>
      searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' })
    );
    expect(statement).toContain(LIBRARY_JOIN);
    expect(statement).toContain(`"${SCHEMA}"."flowsheet"."request_flag"`);
    expect(statement).toContain(`"${SCHEMA}"."library"."on_streaming"`);
  });
});
