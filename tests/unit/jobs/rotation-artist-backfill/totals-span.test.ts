import { jest } from '@jest/globals';

import type { BulkCacheRefreshResponse } from '@wxyc/lml-client';

import type { FetchOutcome } from '../../../../jobs/rotation-artist-backfill/lml-fetch';

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
const mockStartSpan = jest.fn((_opts: SpanOpts, callback: (span: SpanLike) => unknown): unknown =>
  callback(spanInstance)
);
jest.mock('@sentry/node', () => ({
  startSpan: (opts: SpanOpts, callback: (span: SpanLike) => unknown): unknown => mockStartSpan(opts, callback),
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

const lastSpanOpts = (): SpanOpts => mockStartSpan.mock.calls[0][0];

// dry-run reaches projectTotalsSpan without invoking fetchFn or the per-batch
// spans, so the only startSpan call in scope is the totals span.
const runDry = (ids: number[]) =>
  runBackfill({ loadIdentityIds: jest.fn<() => Promise<number[]>>().mockResolvedValue(ids), dryRun: true });

// non-dry-run: stub fetchFn so the real per-batch `http.client` span never
// fires; projectTotalsSpan still runs from the finally block, so the totals
// span is again the only startSpan call — but now on the production code path
// that actually feeds the BS#1402 alerts. (An empty `{}` response is treated
// as a batch error by tallyBatch, which is fine — we only assert the span.)
const runLive = (ids: number[]) => {
  const fetchFn = jest
    .fn<(batch: number[]) => Promise<FetchOutcome<BulkCacheRefreshResponse>>>()
    .mockResolvedValue({ kind: 'ok', value: {} as BulkCacheRefreshResponse });
  return runBackfill({
    loadIdentityIds: jest.fn<() => Promise<number[]>>().mockResolvedValue(ids),
    fetchFn,
    concurrency: 1,
    dryRun: false,
  });
};

describe('rotation-artist-backfill run.totals span (BS#1428 op pin + BS#1081 numeric pin)', () => {
  beforeEach(() => {
    mockStartSpan.mockClear();
  });

  it('fires the totals span once with the rotation-artist-backfill.totals op (dry-run)', async () => {
    await runDry([1, 2, 3]);

    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    expect(lastSpanOpts().name).toBe('rotation-artist-backfill.run.totals');
    expect(lastSpanOpts().op).toBe('rotation-artist-backfill.totals');
  });

  it('fires the totals span with the same name + op on the non-dry-run (production) path', async () => {
    // The path that actually feeds the alerts. A regression emitting the
    // totals span only in dry-run would pass the dry-run test above but fail
    // here — that gap is exactly what this case guards.
    await runLive([1, 2, 3]);

    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    expect(lastSpanOpts().name).toBe('rotation-artist-backfill.run.totals');
    expect(lastSpanOpts().op).toBe('rotation-artist-backfill.totals');
    expect((lastSpanOpts().attributes ?? {})['backfill.dry_run']).toBe(0);
  });

  it('sets every backfill counter as a number at span creation', async () => {
    await runDry([1, 2, 3]);

    const attrs = lastSpanOpts().attributes ?? {};
    expect(attrs['backfill.identities_scanned']).toBe(3);
    expect(attrs['backfill.dry_run']).toBe(1);
    for (const key of COUNTER_KEYS) {
      expect(typeof attrs[key]).toBe('number');
    }
  });
});
