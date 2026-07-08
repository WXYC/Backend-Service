/**
 * Pins the BS#1563 fix: the run-totals span must carry op
 * `flowsheet-metadata-backfill.totals` so a Sentry alert filtering
 * `span.op:flowsheet-metadata-backfill.*` matches it, and it must expose every
 * totals bucket — including `enrich_error` — as a numeric span attribute so the
 * poison-pill wedge that went unnoticed for ~2.5 weeks (#1560 / #1561) is
 * queryable and alertable rather than log-only.
 *
 * Mirrors `tests/unit/jobs/rotation-artist-backfill/totals-span.test.ts`
 * (the BS#1428 / PR #1459 precedent). The counters are numeric at startSpan
 * creation (not via late setAttribute), per the BS#1081 convention — late
 * `setAttribute` calls index numbers as strings and break sum/avg/p95
 * aggregation.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';

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

import { runBackfill, type EnrichFn, type LookupFn } from '../../../../jobs/flowsheet-metadata-backfill/orchestrate';
import type { LookupResponse } from '@wxyc/lml-client';

const TOTALS_KEYS = [
  'backfill.scanned',
  'backfill.enriched_match',
  'backfill.enriched_match_raced',
  'backfill.enriched_no_match',
  'backfill.enriched_no_match_raced',
  'backfill.lml_error',
  'backfill.enrich_error',
];

const matchedResponse: LookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { release_id: 100, release_url: 'x' } }],
  search_type: 'direct',
};

const lastSpanOpts = (): SpanOpts => mockStartSpan.mock.calls[0][0];

// One batch of a single row, then an empty batch to terminate the loop. The
// live-activity probe defaults to false in the db mock, so the run reaches the
// `finished` point where the totals span fires; the only startSpan call in
// scope is the totals span.
const runOneRow = () => {
  (db.execute as jest.Mock)
    .mockResolvedValueOnce([{ id: 1, artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja' }])
    .mockResolvedValueOnce([]);
  const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: matchedResponse, cacheHit: false });
  const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');
  return runBackfill({ lookup, enrich, throttleMs: 0, liveActivityLookbackSeconds: 0 });
};

describe('flowsheet-metadata-backfill run.totals span (BS#1563 op + enrich_error pin)', () => {
  beforeEach(() => {
    mockStartSpan.mockClear();
    (db.execute as jest.Mock).mockReset();
  });

  it('fires the totals span once with the flowsheet-metadata-backfill.totals op', async () => {
    await runOneRow();

    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    expect(lastSpanOpts().name).toBe('flowsheet-metadata-backfill.run.totals');
    expect(lastSpanOpts().op).toBe('flowsheet-metadata-backfill.totals');
  });

  it('exposes every totals bucket — including enrich_error — as a number at span creation', async () => {
    await runOneRow();

    const attrs = lastSpanOpts().attributes ?? {};
    expect(attrs['backfill.scanned']).toBe(1);
    expect(attrs['backfill.enriched_match']).toBe(1);
    // enrich_error is the new bucket (#1561) — the corruption tell the wedge
    // needed. It must be present and numeric even when zero.
    expect(attrs['backfill.enrich_error']).toBe(0);
    for (const key of TOTALS_KEYS) {
      expect(typeof attrs[key]).toBe('number');
    }
  });
});
