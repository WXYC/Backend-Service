// WXYC/Backend-Service#2712 (rework): the cascade `searchFlowsheet` runs
// across `tiersFor`'s ordered tier list -- when to advance to the next tier,
// when a cursor pins a single tier and skips the cascade entirely, and how a
// rejected fallback tier is reported and recovered from.
//
// @sentry/node's exports aren't spy-able (non-configurable ESM namespace), so
// stub the one function the service uses with a module factory, mirroring
// search.service.count-cap.test.ts.
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import * as Sentry from '@sentry/node';
import { db } from '../../mocks/database.mock';

beforeEach(() => {
  jest.clearAllMocks();
});

import { searchFlowsheet, encodeCursor } from '../../../apps/backend/services/search.service';

const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  play_date: new Date('2024-06-15T14:30:00Z'),
  cursor_time: '2024-06-15T14:30:00.000000Z',
  artist_name: 'Autechre',
  track_title: 'VI Scose Poise',
  album_title: 'Confield',
  record_label: 'Warp',
  show_id: 100,
  dj_name: 'DJ Test',
  rotation_bin: null,
  request_flag: false,
  on_streaming: null,
  ...overrides,
});

/**
 * A rejection shaped like what `db.execute` actually throws in production for
 * a statement-timeout cancellation -- confirmed empirically (this ticket)
 * through a real `db.execute` call against a real Postgres, with a
 * per-connection `statement_timeout: 50` against `select pg_sleep(1)`:
 * drizzle-orm 0.45.x wraps every query rejection in `DrizzleQueryError`,
 * whose own `.code` is `undefined`; the SQLSTATE is on `.cause.code`
 * (`PostgresError`, parsed off the wire). `extractSqlState` (`@wxyc/database`)
 * reads `.cause.code` first and falls back to a top-level `.code`, so this is
 * the shape it must actually handle -- a bare `{ code: '57014' }` error (what
 * the raw postgres-js driver throws without drizzle's wrapper) would pass a
 * weaker predicate without proving the real one.
 */
const statementTimeoutError = () => {
  const err = new Error('Failed query: select pg_sleep($1)') as Error & { cause: { code: string } };
  err.cause = { code: '57014' };
  return err;
};

describe('cascade: when the word tier alone is enough', () => {
  it('a non-empty word-tier page issues exactly one statement pair -- no cascade', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow()]).mockResolvedValueOnce([{ total: 1 }]);

    const result = await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(1);
  });

  it('no typing term (empty query) issues exactly one statement pair even when the page is empty', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});

describe('cascade: advancing to the prefix tier', () => {
  it('an empty word-tier page with a typing term issues a second statement pair in the prefix tier', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([]) // word data
      .mockResolvedValueOnce([{ total: 0 }]) // word count
      .mockResolvedValueOnce([makeRow()]) // prefix data
      .mockResolvedValueOnce([{ total: 1 }]); // prefix count

    const result = await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(4);
    expect(result.results).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('a non-date sort never cascades, even with a typing term and an empty page', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'artist', order: 'asc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('a cursor request never cascades, even when its tier comes back empty', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await searchFlowsheet({
      q: 'autec',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: encodeCursor('2024-06-15T00:00:00.000000Z', 999, 'word'),
    });

    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('an offset page > 0 cascades when the settled count is proven zero', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([]) // word data (empty)
      .mockResolvedValueOnce([{ total: 0 }]) // word count: proven zero
      .mockResolvedValueOnce([makeRow()]) // prefix data
      .mockResolvedValueOnce([{ total: 1 }]); // prefix count

    const result = await searchFlowsheet({ q: 'autec', page: 2, limit: 10, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(4);
    expect(result.results).toHaveLength(1);
  });

  it('an offset page > 0 does NOT cascade when the page is empty but the count is nonzero (rows exist elsewhere in this tier)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 37 }]);

    const result = await searchFlowsheet({ q: 'autec', page: 2, limit: 10, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(37);
  });

  it('an offset page > 0 does NOT cascade when the page is empty and the count itself failed to settle (unproven, not zero)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Failed query: select pg_sleep($1)'));

    const result = await searchFlowsheet({ q: 'autec', page: 2, limit: 10, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(0);
  });
});

describe('cascade: a rejected fallback tier is not fatal -- but only a cascaded tier, and only a statement timeout', () => {
  it('a TIMED-OUT prefix tier (reached by cascading) ends the cascade, serves the empty word-tier result, and reports once with the fixed fingerprint', async () => {
    const captureException = Sentry.captureException as unknown as jest.Mock;
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (db.execute as jest.Mock)
        .mockResolvedValueOnce([]) // word data: empty
        .mockResolvedValueOnce([{ total: 0 }]) // word count: 0
        .mockRejectedValueOnce(statementTimeoutError()); // prefix data: times out

      const result = await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' });

      // Today's behaviour is preserved: an empty 200, not a 500.
      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);

      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledTimes(1);
      const [, options] = captureException.mock.calls[0];
      expect(options.fingerprint).toEqual(['flowsheet-search-fallback-tier']);
      expect(options.tags).toMatchObject({ tier: 'prefix' });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('a TIMED-OUT prefix tier also swallows the RAW (unwrapped) driver shape -- a bare { code: "57014" } with no .cause', async () => {
    // extractSqlState falls back to a top-level `.code` when there is no
    // `.cause.code` (its own header: "the fallback is what keeps a bare
    // driver error ... classifying the same way as the wrapped production
    // form"), so a double or a lower-level caller that never goes through
    // drizzle's wrapper is handled identically to the real shape above.
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bareError = new Error('canceling statement due to statement timeout') as Error & { code: string };
      bareError.code = '57014';
      (db.execute as jest.Mock)
        .mockResolvedValueOnce([]) // word data: empty
        .mockResolvedValueOnce([{ total: 0 }]) // word count: 0
        .mockRejectedValueOnce(bareError); // prefix data: times out, raw shape

      const result = await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('a NON-TIMEOUT error from a cascaded prefix tier still rejects the request -- only a statement timeout is swallowed', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([]) // word data: empty
      .mockResolvedValueOnce([{ total: 0 }]) // word count: 0
      .mockRejectedValueOnce(new Error('column "search_doc" does not exist')); // prefix data: a real bug, no .code

    await expect(searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' })).rejects.toThrow(
      'column "search_doc" does not exist'
    );
  });

  it("the 'word' tier's own data failure stays fatal -- no fallback, no cascade, no swallow, even for a statement timeout", async () => {
    (db.execute as jest.Mock).mockRejectedValueOnce(statementTimeoutError()).mockResolvedValueOnce([{ total: 0 }]);

    await expect(searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' })).rejects.toThrow(
      'Failed query: select pg_sleep($1)'
    );
  });

  it('a cursor pinned DIRECTLY to a non-word tier (no prior attempt to fall back to) throws on a timeout, exactly like the word tier', async () => {
    (db.execute as jest.Mock).mockRejectedValueOnce(statementTimeoutError()).mockResolvedValueOnce([{ total: 0 }]);

    await expect(
      searchFlowsheet({
        q: 'autec',
        page: 0,
        limit: 50,
        sort: 'date',
        order: 'desc',
        cursor: encodeCursor('2024-06-15T00:00:00.000000Z', 999, 'prefix'),
      })
    ).rejects.toThrow('Failed query: select pg_sleep($1)');
  });

  // Mutation proof (manual; run during implementation): dropping the `i === 0 ||`
  // half of the fatality guard (swallowing ANY tier's timeout, cascaded or
  // not) flips the "cursor pinned directly to a non-word tier" test above to
  // red -- it would return an empty 200 instead of rejecting. Dropping the
  // `!isStatementTimeout(reason) ` half (swallowing every error class from a
  // cascaded tier) flips the "NON-TIMEOUT error" test above to red -- it
  // would also return an empty 200 instead of rejecting.
});

describe('cascade: the cursor carries the resolved tier forward', () => {
  it('a full prefix-tier page emits a cursor with the _pfx marker', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ id: i + 1 }));
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([]) // word data: empty
      .mockResolvedValueOnce([{ total: 0 }]) // word count: 0
      .mockResolvedValueOnce(rows) // prefix data: full page
      .mockResolvedValueOnce([{ total: 1000 }]); // prefix count

    const result = await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.nextCursor).toBeDefined();
    expect(result.nextCursor).toMatch(/_pfx$/);
  });

  it('a _pfx cursor request runs the prefix tier directly -- one statement pair, no word-tier attempt', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow()]).mockResolvedValueOnce([{ total: 1 }]);

    const result = await searchFlowsheet({
      q: 'autec',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: encodeCursor('2024-06-15T00:00:00.000000Z', 999, 'prefix'),
    });

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(1);
  });

  it('a _pfx cursor whose query no longer has a typing term is treated as the word tier, and emits an unmarked cursor', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ id: i + 1 }));
    (db.execute as jest.Mock).mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total: 1000 }]);

    const result = await searchFlowsheet({
      q: 'tv', // 2 chars -- shouldUseTsvector is false, so there is no typing term
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: encodeCursor('2024-06-15T00:00:00.000000Z', 999, 'prefix'),
    });

    // Still only one statement pair (treated as 'word', not re-cascaded).
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.nextCursor).toBeDefined();
    expect(result.nextCursor).not.toMatch(/_pfx$/);
  });

  // Mutation proof (manual; run during implementation): replacing the
  // cascade guard `!(offset === 0 || countTotal === 0)` with an
  // always-cascade-on-empty rule (dropping the guard) flips the two "does
  // NOT cascade" tests above to red -- both would wrongly issue a second
  // statement pair. Replacing `countTotal === 0` with `countTotal != null`
  // (treating an UNPROVEN count as proof) flips "does NOT cascade when the
  // count itself failed to settle" to red for the same reason.
});
