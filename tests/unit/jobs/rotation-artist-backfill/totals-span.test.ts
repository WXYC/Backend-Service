import { jest } from '@jest/globals';

// Pins the BS#1428 fix: the run-totals span must carry op
// `rotation-artist-backfill.totals` so the BS#1402 alert rules — which filter
// `span.op:rotation-artist-backfill.*` — actually match it. Without an op the
// span lands under a generic default op, the wildcard matches nothing, and the
// alerts' `sum(backfill.*)` aggregate resolves over zero rows (the BS#1428
// "no data forever" finding). Also re-pins the BS#1081 convention that the
// counters are numeric at startSpan creation (not via late setAttribute).

type SpanLike = { setAttribute: jest.Mock; setAttributes: jest.Mock };
type SpanOpts = { name: string; op?: string; attributes?: Record<string, unknown> };
const spanInstance: SpanLike = { setAttribute: jest.fn(), setAttributes: jest.fn() };
const mockStartSpan = jest.fn(<T>(_opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): T | Promise<T> =>
  callback(spanInstance)
);
jest.mock('@sentry/node', () => ({
  startSpan: <T>(opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): T | Promise<T> =>
    mockStartSpan(opts, callback),
  getActiveSpan: () => spanInstance,
  setTag: jest.fn(),
  init: jest.fn(),
  captureException: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import { runBackfill } from '../../../../jobs/rotation-artist-backfill/orchestrate';

const COUNTER_KEYS = [
  'backfill.identities_scanned',
  'backfill.identities_resolved',
  'backfill.warmed_releases',
  'backfill.warmed_artists',
  'backfill.not_found',
  'backfill.not_implemented',
  'backfill.lml_error',
];

// dry-run reaches projectTotalsSpan without invoking fetchFn or the per-batch
// spans, so the only startSpan call in scope is the totals span.
const runDry = (ids: number[]) =>
  runBackfill({ loadIdentityIds: jest.fn<() => Promise<number[]>>().mockResolvedValue(ids), dryRun: true });

describe('rotation-artist-backfill run.totals span (BS#1428 op pin + BS#1081 numeric pin)', () => {
  beforeEach(() => {
    mockStartSpan.mockClear();
  });

  it('fires the totals span once with the rotation-artist-backfill.totals op', async () => {
    await runDry([1, 2, 3]);

    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    const opts = mockStartSpan.mock.calls[0][0];
    expect(opts.name).toBe('rotation-artist-backfill.run.totals');
    expect(opts.op).toBe('rotation-artist-backfill.totals');
  });

  it('sets every backfill counter as a number at span creation', async () => {
    await runDry([1, 2, 3]);

    const attrs = mockStartSpan.mock.calls[0][0].attributes ?? {};
    expect(attrs['backfill.identities_scanned']).toBe(3);
    expect(attrs['backfill.dry_run']).toBe(1);
    for (const key of COUNTER_KEYS) {
      expect(typeof attrs[key]).toBe('number');
    }
  });
});
