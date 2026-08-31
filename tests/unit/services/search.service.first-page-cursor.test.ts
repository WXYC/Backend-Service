/**
 * BS#2344 — `GET /flowsheet/search` never emitted `nextCursor` on the first
 * page, so cursor pagination could never start and dj-site's Previous Sets
 * archive was permanently capped at one page.
 *
 * The emit gate was `useCursor && results.length === limit` — conditioned on a
 * cursor having been passed *in* rather than on there being a next page. The
 * first request of any session carries no cursor, so the forward chain had no
 * first link.
 *
 * Widening the gate alone would have been wrong, and that is what the walk
 * test below pins. Page 0 and cursor mode used to compile DIFFERENT `ORDER BY`
 * clauses: cursor mode ordered `add_time <dir>, id <dir>` (matching the
 * compound cursor predicate), page 0 ordered by `add_time` alone. Postgres is
 * free to return rows sharing an `add_time` in any order under the untied
 * clause, and batch-imported legacy entries all carry one import timestamp, so
 * tie groups are large and routinely straddle a page boundary. A cursor
 * derived from whichever row of the group happened to land last on page 0
 * would then skip or duplicate the rest of that group on page 2. So the
 * ordering is now deterministic whenever cursor pagination can apply
 * (`sort === 'date'`), cursor passed in or not, and `nextCursor` is emitted
 * off that deterministic last row.
 *
 * Uses the real drizzle-orm `sql` tag (the unit suite auto-mocks it) compiled
 * with PgDialect, mirroring search.service.escape.test.ts and
 * search.service.count-cap.test.ts, so the assertions land on the SQL the
 * service actually emits.
 */
jest.unmock('drizzle-orm');

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../mocks/database.mock';

const dialect = new PgDialect();

/** Compile the SQL text + bound params for the Nth db.execute call (0 = data query). */
const compiledExecuteCall = (n = 0) => {
  const stmt = (db.execute as jest.Mock).mock.calls[n][0];
  return dialect.sqlToQuery(stmt);
};

/**
 * The `ORDER BY` terms of a compiled statement, resolved to the column each
 * one sorts on.
 *
 * The unit suite mocks `@wxyc/database`, so `flowsheet.add_time` is the plain
 * string `'add_time'` rather than a `PgColumn`; drizzle therefore binds it as
 * a parameter and the compiled text reads `order by $11 desc, $12 desc`. Each
 * placeholder is resolved back through the bound params to recover the column
 * name, which is what the assertions want to talk about.
 */
type OrderByTerm = { column: unknown; direction: 'asc' | 'desc' | null };

const orderByTerms = (text: string, params: readonly unknown[]): OrderByTerm[] => {
  const lower = text.toLowerCase();
  const at = lower.lastIndexOf('order by');
  if (at === -1) return [];
  const clause = lower.slice(at + 'order by'.length).split(/\blimit\b/)[0];
  return clause
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => {
      const placeholder = term.match(/\$(\d+)/);
      const direction = /\basc\b/.test(term) ? 'asc' : /\bdesc\b/.test(term) ? 'desc' : null;
      return { column: placeholder ? params[Number(placeholder[1]) - 1] : undefined, direction };
    });
};

const orderByOf = (n = 0) => {
  const { sql: text, params } = compiledExecuteCall(n);
  return orderByTerms(text, params);
};

beforeEach(() => {
  jest.clearAllMocks();
});

import { searchFlowsheet, encodeCursor } from '../../../apps/backend/services/search.service';

const T = (hour: number) => new Date(`2026-08-30T${String(hour).padStart(2, '0')}:00:00.000Z`);

type FixtureRow = { id: number; add_time: Date };

/**
 * Nine track rows in three `add_time` groups, modelled on a batch import: one
 * singleton and two four-row tie groups. Under the deterministic
 * `add_time DESC, id DESC` ordering the canonical sequence is 9..1, and at
 * `limit: 3` BOTH page boundaries fall strictly inside a tie group (7|6 splits
 * the 11:00 group, 4|3 splits the 10:00 group) — which is exactly the shape
 * that a cursor taken off an untied page 0 gets wrong.
 */
const FIXTURE: FixtureRow[] = [
  { id: 9, add_time: T(12) },
  { id: 8, add_time: T(11) },
  { id: 7, add_time: T(11) },
  { id: 6, add_time: T(11) },
  { id: 5, add_time: T(11) },
  { id: 4, add_time: T(10) },
  { id: 3, add_time: T(10) },
  { id: 2, add_time: T(10) },
  { id: 1, add_time: T(10) },
];

const CANONICAL_DESC_IDS = [9, 8, 7, 6, 5, 4, 3, 2, 1];

const asResultRow = (row: FixtureRow) => ({
  id: row.id,
  play_date: row.add_time,
  artist_name: 'Chuquimamani-Condori',
  track_title: `Call Your Name #${row.id}`,
  album_title: 'Edits',
  record_label: 'self-released',
  show_id: 100,
  dj_name: 'DJ Test',
});

/**
 * A deliberately hostile stand-in for Postgres's freedom within a tie group.
 *
 * When the compiled `ORDER BY` carries the `id` tiebreaker, rows sharing an
 * `add_time` come back in the sort's own direction — the real index/sort
 * behaviour. When it does not, this returns the tie group in the OPPOSITE
 * direction: still a legal ordering under `ORDER BY add_time <dir>` alone, and
 * chosen so that any code depending on the untied clause's row order fails
 * loudly instead of passing by luck on a stable sort.
 */
function orderRows(rows: FixtureRow[], hasIdTiebreak: boolean, ascending: boolean): FixtureRow[] {
  const dir = ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const byTime = dir * (a.add_time.getTime() - b.add_time.getTime());
    if (byTime !== 0) return byTime;
    return (hasIdTiebreak ? dir : -dir) * (a.id - b.id);
  });
}

/**
 * Execute a compiled statement against FIXTURE, honouring the parts of the
 * query the pagination contract actually rests on: the compound cursor
 * predicate, the sort direction, the ORDER BY tiebreaker (or its absence),
 * LIMIT and OFFSET.
 *
 * Every value is read back through its `$n` placeholder rather than a fixed
 * parameter position, so the simulator does not quietly depend on how many
 * parameters the WHERE clause happens to contribute.
 */
function runDataQuery(text: string, params: readonly unknown[]) {
  const lower = text.toLowerCase();
  const terms = orderByTerms(text, params);
  const hasIdTiebreak = terms.length > 1 && terms[1].column === 'id';
  const ascending = terms[0]?.direction === 'asc';

  const boundNumber = (placeholder: string) => Number(params[Number(placeholder) - 1]);
  const boundTimestamp = (placeholder: string) => {
    const value = params[Number(placeholder) - 1];
    if (typeof value !== 'string') throw new Error(`cursor timestamp bound as ${typeof value}, expected string`);
    return Date.parse(value);
  };

  const limitMatch = lower.match(/\blimit \$(\d+)/);
  const offsetMatch = lower.match(/\boffset \$(\d+)/);
  const limit = limitMatch ? boundNumber(limitMatch[1]) : FIXTURE.length;
  const offset = offsetMatch ? boundNumber(offsetMatch[1]) : 0;

  let rows = orderRows(FIXTURE, hasIdTiebreak, ascending);

  const cursorPredicate = lower.match(/\$(\d+)::timestamptz\s*,\s*\$(\d+)\s*\)/);
  if (cursorPredicate) {
    const cursorTime = boundTimestamp(cursorPredicate[1]);
    const cursorId = boundNumber(cursorPredicate[2]);
    // Row-wise `(add_time, id) < (cursor…)` — or `>` when ordering ascending.
    rows = rows.filter((r) => {
      const t = r.add_time.getTime();
      const strictlyPast = ascending ? t > cursorTime : t < cursorTime;
      const tiedAndPast = t === cursorTime && (ascending ? r.id > cursorId : r.id < cursorId);
      return strictlyPast || tiedAndPast;
    });
  }

  return rows.slice(offset, offset + limit).map(asResultRow);
}

/** Route data queries through the fixture simulator and answer counts from it. */
function mockFixtureBackedExecute() {
  (db.execute as jest.Mock).mockImplementation((stmt: unknown) => {
    const { sql: text, params } = dialect.sqlToQuery(stmt as never);
    if (text.toLowerCase().includes('count(*)')) {
      return Promise.resolve([{ total: FIXTURE.length }]);
    }
    return Promise.resolve(runDataQuery(text, params));
  });
}

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  ...asResultRow({ id: 1, add_time: T(12) }),
  ...overrides,
});

/** searchFlowsheet issues the data query first, then the count query. */
const mockDataAndCount = (rows: unknown[], total: number) => {
  (db.execute as jest.Mock).mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total }]);
};

const fullPageOf = (limit: number) => Array.from({ length: limit }, (_, i) => makeRow({ id: 100 - i }));

describe('BS#2344: nextCursor on the first page (no cursor passed in)', () => {
  it('emits nextCursor for a full first page under sort=date with no cursor', async () => {
    const rows = fullPageOf(50);
    mockDataAndCount(rows, 1000);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const last = result.results[49];
    expect(result.nextCursor).toBe(encodeCursor(last.play_date, last.id));
  });

  it.each([['desc' as const], ['asc' as const]])('emits nextCursor on a cold start in %s order', async (order) => {
    mockDataAndCount(fullPageOf(10), 1000);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 10, sort: 'date', order });

    expect(result.nextCursor).toBeDefined();
  });

  it('emits nextCursor for a full page in offset mode beyond page 0', async () => {
    // Offset-mode callers other than dj-site still page with `page`; a full
    // page there is just as much "there is more" as page 0 is.
    mockDataAndCount(fullPageOf(25), 1000);

    const result = await searchFlowsheet({ q: '', page: 3, limit: 25, sort: 'date', order: 'desc' });

    expect(result.nextCursor).toBeDefined();
  });

  it('omits nextCursor for a short first page — a partial page is the end', async () => {
    mockDataAndCount([makeRow({ id: 7 }), makeRow({ id: 6 })], 2);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.nextCursor).toBeUndefined();
  });

  it('omits nextCursor for an empty page', async () => {
    mockDataAndCount([], 0);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.nextCursor).toBeUndefined();
  });

  // Cursor mode is date-only by design: `parseCursor` is consulted only when
  // `sort === 'date'`, so a cursor emitted under any other sort would be
  // silently ignored on the way back in and the client would re-fetch page 0
  // forever. The emit gate has to keep the same sort restriction the intake
  // gate has.
  it.each([['artist' as const], ['song' as const], ['dj' as const]])(
    'omits nextCursor under sort=%s even on a full page',
    async (sort) => {
      mockDataAndCount(fullPageOf(50), 1000);

      const result = await searchFlowsheet({ q: '', page: 0, limit: 50, sort, order: 'asc' });

      expect(result.nextCursor).toBeUndefined();
    }
  );
});

describe('BS#2344: deterministic ordering wherever a cursor can be emitted', () => {
  it.each([['desc' as const], ['asc' as const]])(
    'adds the id tiebreaker to a cursorless date sort (%s)',
    async (order) => {
      mockDataAndCount([], 0);

      await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order });

      // Tiebreaker present, and sorted the same direction as the primary key
      // so it matches the compound cursor predicate's row-wise comparison.
      expect(orderByOf()).toEqual([
        { column: 'add_time', direction: order },
        { column: 'id', direction: order },
      ]);
    }
  );

  it('keeps the id tiebreaker when a cursor IS supplied (unchanged behaviour)', async () => {
    mockDataAndCount([], 0);

    await searchFlowsheet({
      q: '',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: '2026-08-30T12:00:00.000Z_999',
    });

    expect(orderByOf()).toEqual([
      { column: 'add_time', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ]);
  });

  it.each([
    ['artist' as const, 'artist_name'],
    ['song' as const, 'track_title'],
    ['dj' as const, 'dj_name'],
  ])('leaves sort=%s without an id tiebreaker — no cursor is ever emitted for it', async (sort, column) => {
    mockDataAndCount([], 0);

    await searchFlowsheet({ q: '', page: 0, limit: 50, sort, order: 'asc' });

    expect(orderByOf()).toEqual([{ column, direction: 'asc' }]);
  });
});

describe('BS#2344: cold-start walk across tie groups', () => {
  it('walks the whole archive from no cursor without skipping or duplicating a row', async () => {
    mockFixtureBackedExecute();

    const seen: number[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    let requests = 0;

    do {
      const result = await searchFlowsheet({ q: '', page: 0, limit: 3, sort: 'date', order: 'desc', cursor });
      seen.push(...result.results.map((r) => r.id));
      pageSizes.push(result.results.length);
      cursor = result.nextCursor;
      requests += 1;
    } while (cursor !== undefined && requests < 10);

    // Four pages of three, then one empty page. The final full page emits a
    // cursor and costs one extra request that returns nothing — correct and
    // standard for cursor pagination; avoiding it would mean counting.
    expect(pageSizes).toEqual([3, 3, 3, 0]);
    expect(requests).toBe(4);

    // Every row exactly once, in order — no skip across the 7|6 boundary and
    // no duplicate across the 4|3 one, the two tie-group splits.
    expect(seen).toEqual(CANONICAL_DESC_IDS);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('walks ascending order across the same tie groups', async () => {
    mockFixtureBackedExecute();

    const seen: number[] = [];
    let cursor: string | undefined;
    let requests = 0;

    do {
      const result = await searchFlowsheet({ q: '', page: 0, limit: 3, sort: 'date', order: 'asc', cursor });
      seen.push(...result.results.map((r) => r.id));
      cursor = result.nextCursor;
      requests += 1;
    } while (cursor !== undefined && requests < 10);

    // Ascending, the two boundaries land at 3|4 and 6|7 — both inside a tie
    // group, same as the descending walk.
    expect(seen).toEqual([...CANONICAL_DESC_IDS].reverse());
    expect(new Set(seen).size).toBe(seen.length);
  });
});
