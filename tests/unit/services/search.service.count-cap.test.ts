// BS#1681: the exact `COUNT(*)` over the full track set is an unbounded parallel
// seq scan (measured 12.3s / 1.97M rows in prod) that blows past the 5s HTTP
// `statement_timeout`, and because it ran in a `Promise.all` alongside the data
// query, its rejection 500'd the whole endpoint — including the 4ms data page
// that was already in hand. Two fixes, tested here:
//   1. Cap the count with a `LIMIT COUNT_CAP + 1` subquery so cost is bounded
//      regardless of selectivity (33-105ms in prod).
//   2. Run data + count via `Promise.allSettled` so a count failure degrades to
//      a lower-bound total instead of failing the request.
//
// Uses the real drizzle-orm `sql` tag (compiled with PgDialect) to assert the
// cap reaches the count query, mirroring search.service.escape.test.ts.
jest.unmock('drizzle-orm');

// @sentry/node's exports aren't spy-able (non-configurable ESM namespace), so
// stub the one function the service uses with a module factory.
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import * as Sentry from '@sentry/node';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../mocks/database.mock';

const dialect = new PgDialect();

/** Compile the SQL text + bound params for the Nth db.execute call (0 = data, 1 = count). */
const compiledExecuteCall = (n: number) => {
  const stmt = (db.execute as jest.Mock).mock.calls[n][0];
  return dialect.sqlToQuery(stmt);
};

beforeEach(() => {
  jest.clearAllMocks();
});

import { searchFlowsheet, COUNT_CAP } from '../../../apps/backend/services/search.service';

const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  play_date: new Date('2024-06-15T14:30:00Z'),
  artist_name: 'Juana Molina',
  track_title: 'la paradoja',
  album_title: 'DOGA',
  record_label: 'Sonamos',
  show_id: 100,
  dj_name: 'DJ Test',
  ...overrides,
});

/** searchFlowsheet issues the data query first, then the count query. */
const mockDataAndCount = (rows: ReturnType<typeof makeRow>[] = [], total = 0) => {
  (db.execute as jest.Mock).mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total }]);
};

describe('BS#1681 fix #1: capped count query', () => {
  it('wraps the count in a LIMIT COUNT_CAP + 1 subquery (empty query)', async () => {
    mockDataAndCount();

    await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(1);
    const lower = text.toLowerCase();
    expect(lower).toContain('count(*)');
    // The unbounded `COUNT(*) FROM flowsheet` is replaced by a bounded
    // `COUNT(*) FROM (SELECT 1 ... LIMIT $n)` derived table.
    expect(lower).toMatch(/from\s*\(\s*select 1/);
    expect(lower).toContain('limit');
    expect(params).toContain(COUNT_CAP + 1);
  });

  it('caps the count for a broad tsvector query too (q=the)', async () => {
    mockDataAndCount();

    await searchFlowsheet({ q: 'the', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(1);
    const lower = text.toLowerCase();
    expect(lower).toMatch(/from\s*\(\s*select 1/);
    // The broad predicate is preserved inside the capped derived table.
    expect(lower).toContain('websearch_to_tsquery');
    expect(params).toContain(COUNT_CAP + 1);
  });

  it('leaves the data query (call 0) unbounded by the count cap', async () => {
    mockDataAndCount();

    await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(0);
    // Data query is limited by the caller's `limit` (50), not the count cap.
    expect(params).toContain(50);
    expect(params).not.toContain(COUNT_CAP + 1);
  });

  it('returns the capped count value verbatim from the count query', async () => {
    // When the true match set exceeds the cap the count query returns
    // COUNT_CAP + 1; the service passes it through unchanged.
    mockDataAndCount([makeRow()], COUNT_CAP + 1);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.total).toBe(COUNT_CAP + 1);
  });

  it('does not report to Sentry when the count query succeeds', async () => {
    // The degradation capture must stay inside the count-failure branch — a
    // regression that fired it unconditionally would spam Sentry on every
    // successful search (the hot, high-volume default listing).
    const captureException = Sentry.captureException as unknown as jest.Mock;
    mockDataAndCount([makeRow()], 42);

    const result = await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.total).toBe(42);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('BS#1681 fix #2: count failure degrades instead of 500-ing', () => {
  it('resolves with the data page and a lower-bound total when the count query rejects', async () => {
    const captureException = Sentry.captureException as unknown as jest.Mock;
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 })];
    (db.execute as jest.Mock)
      .mockResolvedValueOnce(rows) // data query succeeds
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout')); // count fails

    const result = await searchFlowsheet({ q: 'the', page: 2, limit: 10, sort: 'date', order: 'desc' });

    // Data is served, not dropped.
    expect(result.results).toHaveLength(2);
    // Lower bound: offset (page * limit) + rows on this page.
    expect(result.total).toBe(2 * 10 + 2);
    // The swallowed failure is still reported so we retain visibility.
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('still throws when the DATA query fails — nothing to serve is fatal', async () => {
    (db.execute as jest.Mock)
      .mockRejectedValueOnce(new Error('data boom')) // data query fails
      .mockResolvedValueOnce([{ total: 5 }]); // count succeeds

    await expect(searchFlowsheet({ q: 'the', page: 0, limit: 50, sort: 'date', order: 'desc' })).rejects.toThrow(
      'data boom'
    );
  });

  it('uses results.length as the lower bound in cursor mode (offset is 0)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ id: i + 1 }));
    (db.execute as jest.Mock)
      .mockResolvedValueOnce(rows)
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

    const result = await searchFlowsheet({
      q: '',
      page: 3,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: '2024-06-16T00:00:00.000Z_999',
    });

    // Cursor mode zeroes the offset, so the lower bound is just this page's rows.
    expect(result.total).toBe(5);
  });
});
