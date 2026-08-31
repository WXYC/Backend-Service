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
 * Widening the gate alone would have been wrong. Page 0 and cursor mode used
 * to compile DIFFERENT `ORDER BY` clauses: cursor mode ordered
 * `add_time <dir>, id <dir>` (matching the compound cursor predicate), page 0
 * ordered by `add_time` alone. Postgres is free to return rows sharing an
 * `add_time` in any order under the untied clause, and batch-imported legacy
 * entries all carry one import timestamp, so tie groups are large and
 * routinely straddle a page boundary. A cursor derived from whichever row of
 * the group happened to land last on page 0 would then skip or duplicate the
 * rest of that group. So the ordering is now deterministic whenever cursor
 * pagination can apply (`sort === 'date'`), cursor passed in or not.
 *
 * The third piece is precision: the cursor's timestamp is selected from the
 * query as a full-microsecond ISO string (`cursor_time`) rather than derived
 * from `play_date`, which is a JS `Date` rendering in every code path that
 * produces one and therefore floored to milliseconds. See `CURSOR_TIME_EXPR`.
 *
 * The end-to-end duplicate/skip symptom is pinned in
 * `tests/integration/flowsheet-search-cursor-walk.spec.js`, which walks real
 * pages against real Postgres. What belongs HERE is the compiled SQL — the
 * ordering, the cursor predicate, and the cursor expression — because the unit
 * suite mocks `@wxyc/database` and can see the statement but never a row's
 * true timestamp resolution.
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

/**
 * A row as the DATA QUERY returns it — `play_date` and `cursor_time` are the
 * same instant at two resolutions, which is the distinction the cursor rests
 * on. `play_date` is millisecond-floored (it is what a JS `Date` can hold);
 * `cursor_time` is the microsecond string Postgres rendered.
 */
const makeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  play_date: new Date('2026-08-30T12:00:00.123Z'),
  cursor_time: '2026-08-30T12:00:00.123456Z',
  artist_name: 'Chuquimamani-Condori',
  track_title: 'Call Your Name',
  album_title: 'Edits',
  record_label: 'self-released',
  show_id: 100,
  dj_name: 'DJ Test',
  ...overrides,
});

/** searchFlowsheet issues the data query first, then the count query. */
const mockDataAndCount = (rows: unknown[], total: number) => {
  (db.execute as jest.Mock).mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total }]);
};

const fullPageOf = (limit: number) => Array.from({ length: limit }, (_, i) => makeRow({ id: 100 - i }));

describe('BS#2344: nextCursor on the first page (no cursor passed in)', () => {
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

describe('BS#2344: the compiled cursor predicate', () => {
  it.each([
    ['desc' as const, '<'],
    ['asc' as const, '>'],
  ])('compiles a strict row-wise (add_time, id) comparison for %s, and drops OFFSET', async (order, cmp) => {
    mockDataAndCount([], 0);

    await searchFlowsheet({
      q: '',
      page: 3,
      limit: 50,
      sort: 'date',
      order,
      cursor: '2026-08-30T12:00:00.000Z_999',
    });

    const { sql: text } = compiledExecuteCall(0);
    // The mock binds columns as params, so the left-hand side of the
    // comparison compiles to `($n, $m)`; what matters is that the operator
    // is strict and the right-hand side is cast to timestamptz.
    expect(text).toMatch(new RegExp(`\\)\\s*${cmp}\\s*\\(\\$\\d+::timestamptz`));
    // `page: 3` above is deliberate: an inbound cursor replaces offset
    // paging outright rather than compounding with it.
    expect(text.toLowerCase()).not.toContain('offset');
  });

  it('keeps LIMIT/OFFSET when no cursor was supplied', async () => {
    mockDataAndCount([], 0);

    await searchFlowsheet({ q: '', page: 3, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text } = compiledExecuteCall(0);
    expect(text.toLowerCase()).toContain('offset');
    expect(text).not.toMatch(/::timestamptz/);
  });
});

describe("BS#2344: the cursor carries the row's full timestamp resolution", () => {
  it('selects the cursor timestamp from the query at microsecond precision', async () => {
    mockDataAndCount([], 0);

    await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text } = compiledExecuteCall(0);
    // `.US` is the microseconds field; anything less would floor the cursor
    // below the boundary row's real add_time. Rendered by Postgres in UTC so
    // the token does not vary with the session timezone.
    expect(text).toMatch(/to_char\(\$\d+ AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS cursor_time/);
  });

  it('builds the cursor from cursor_time, never from the floored play_date', async () => {
    // The two fields are the same instant at two resolutions. `play_date` is
    // what the response contract carries and what a JS `Date` can hold;
    // `cursor_time` is what Postgres actually stored.
    mockDataAndCount([makeRow({ id: 42 })], 1000);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 1, sort: 'date', order: 'desc' });

    expect(result.nextCursor).toBe(encodeCursor('2026-08-30T12:00:00.123456Z', 42));
    expect(result.nextCursor).not.toBe(encodeCursor(result.results[0].play_date, 42));
  });

  it('keeps cursor_time out of the returned SearchResult objects', async () => {
    // `SearchResult` is the api.yaml response contract; the cursor column is
    // an implementation detail of the query and must not leak into it.
    mockDataAndCount([makeRow()], 1);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0]).not.toHaveProperty('cursor_time');
    expect(result.results[0].play_date).toBe('2026-08-30T12:00:00.123Z');
  });
});
