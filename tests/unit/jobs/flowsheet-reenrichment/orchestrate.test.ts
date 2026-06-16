/**
 * Unit tests for flowsheet-reenrichment orchestrate.ts.
 *
 * Pins the behaviors the one-shot drain depends on:
 *   1. The loadBatch SELECT carries all four WHERE predicates:
 *      metadata_status='enriched_no_match', album_id IS NULL,
 *      artist_name IS NOT NULL, add_time < $BACKFILL_CUTOFF_TS,
 *      plus the id-cursor and ORDER BY / LIMIT.
 *   2. The ID cursor advances across batches and the loop terminates when
 *      a batch returns empty.
 *   3. Per-row outcome counters (match, match_raced, still_no_match,
 *      lml_error) are correctly accumulated and logged.
 *   4. Idempotency: the second pass over a row where enrich returns
 *      'match_raced' is counted correctly and does not corrupt totals.
 *   5. Cooperative pause defers batches when live activity is observed.
 *   6. lml_error: lookup throws → the row is not passed to enrich, the
 *      counter increments, and the loop continues.
 */
import { jest } from '@jest/globals';

import { db, checkLiveActivity as mockCheckLiveActivity } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  runReenrichment,
  type LookupFn,
  type EnrichFn,
  BATCH_SIZE,
  resolveBatchSize,
  resolveCutoffTs,
  resolveLiveActivityLookback,
  resolveLiveActivityPauseMs,
} from '../../../../jobs/flowsheet-reenrichment/orchestrate';

type SqlLike = { sql?: string | string[]; queryChunks?: Array<string | { value?: unknown }> };
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'number' || typeof chunk.value === 'string') return String(chunk.value);
        return '';
      })
      .join('');
  }
  return '';
};

const matchedResponse: LookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { release_id: 100, release_url: 'x' } }],
  search_type: 'direct',
};

const noMatchResponse: LookupResponse = {
  results: [],
  search_type: 'none',
};

const matchedResult = () => ({ response: matchedResponse, cacheHit: false as const });
const noMatchResult = () => ({ response: noMatchResponse, cacheHit: false as const });

const CUTOFF = '2026-06-16T17:53:53Z';

const makeRow = (id: number) => ({
  id,
  artist_name: 'Autechre',
  album_title: 'Confield',
  track_title: null,
});

describe('resolveBatchSize', () => {
  it('falls back to BATCH_SIZE when env var is unset', () => {
    expect(resolveBatchSize(undefined)).toBe(BATCH_SIZE);
  });

  it('returns the parsed value for a valid positive integer', () => {
    expect(resolveBatchSize('200')).toBe(200);
  });

  it('throws on zero or negative', () => {
    expect(() => resolveBatchSize('0')).toThrow(/BACKFILL_BATCH_SIZE/);
    expect(() => resolveBatchSize('-1')).toThrow(/BACKFILL_BATCH_SIZE/);
  });
});

describe('resolveCutoffTs', () => {
  it('throws when BACKFILL_CUTOFF_TS is not set', () => {
    expect(() => resolveCutoffTs(undefined)).toThrow(/BACKFILL_CUTOFF_TS/);
  });

  it('returns the value when set', () => {
    expect(resolveCutoffTs(CUTOFF)).toBe(CUTOFF);
  });
});

describe('resolveLiveActivityLookback', () => {
  it('falls back to 60 when env var is unset', () => {
    expect(resolveLiveActivityLookback(undefined)).toBe(60);
  });

  it('accepts 0 to disable the cooperative pause', () => {
    expect(resolveLiveActivityLookback('0')).toBe(0);
  });
});

describe('resolveLiveActivityPauseMs', () => {
  it('falls back to 30000 when env var is unset', () => {
    expect(resolveLiveActivityPauseMs(undefined)).toBe(30_000);
  });

  it('accepts 0', () => {
    expect(resolveLiveActivityPauseMs('0')).toBe(0);
  });
});

describe('runReenrichment — WHERE filter', () => {
  it('SELECT carries all four predicates: metadata_status, album_id IS NULL, artist_name IS NOT NULL, add_time < cutoff', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]); // second SELECT → empty → stop

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 100, liveActivityLookbackSeconds: 0 });

    const firstSelectSql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(firstSelectSql).toMatch(/enriched_no_match/);
    expect(firstSelectSql).toMatch(/album_id.*IS NULL|IS NULL.*album_id/i);
    expect(firstSelectSql.toLowerCase()).toMatch(/artist_name.*is not null/);
    expect(firstSelectSql).toMatch(/add_time/);
  });

  it('ID cursor advances across batches: loop terminates when batch returns empty', async () => {
    // Three batches: 2 rows, 1 row, then empty → loop exits
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(10), makeRow(20)])
      .mockResolvedValueOnce([makeRow(30)])
      .mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 2,
      liveActivityLookbackSeconds: 0,
    });

    // 3 SELECT calls (batch1=2 rows, batch2=1 row, batch3=empty)
    expect((db.execute as jest.Mock).mock.calls.length).toBe(3);
    // All 3 rows were scanned
    expect(result.totals.scanned).toBe(3);
    expect(result.totals.still_no_match).toBe(3);
  });
});

describe('runReenrichment — outcome counters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    { name: 'match', enrichOutcome: 'match' as const, expectedField: 'match' },
    { name: 'match_raced', enrichOutcome: 'match_raced' as const, expectedField: 'match_raced' },
    { name: 'still_no_match', enrichOutcome: 'still_no_match' as const, expectedField: 'still_no_match' },
  ])('$name outcome: scanned=1, $expectedField=1', async ({ enrichOutcome, expectedField }) => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue(enrichOutcome);

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.totals.scanned).toBe(1);
    expect(result.totals[expectedField as keyof typeof result.totals]).toBe(1);
  });

  it('lml_error: lookup throws → enrich not called, lml_error increments, loop continues', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2)]).mockResolvedValueOnce([]);

    const lookup = jest
      .fn<LookupFn>()
      .mockRejectedValueOnce(new Error('LML timeout'))
      .mockResolvedValue(noMatchResult());

    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.totals.lml_error).toBe(1);
    expect(result.totals.still_no_match).toBe(1);
    expect(result.totals.scanned).toBe(2);
    // enrich was called only for the second row (first threw)
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('flipped = match (not match_raced) in returned totals', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValueOnce('match').mockResolvedValueOnce('match_raced');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.totals.match).toBe(1);
    expect(result.totals.match_raced).toBe(1);
    // flipped is the non-raced subset
    expect(result.flipped).toBe(1);
  });
});

describe('runReenrichment — cooperative pause', () => {
  it('defers when live activity is detected, continues when quiet', async () => {
    // Two activity probes fire, then quiet
    (mockCheckLiveActivity as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 0,
      checkLiveActivity: mockCheckLiveActivity,
    });

    // Probe was called at least 3 times (twice truthy, once falsy)
    expect(mockCheckLiveActivity.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('skips probe when liveActivityLookbackSeconds=0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: mockCheckLiveActivity,
    });

    expect(mockCheckLiveActivity).not.toHaveBeenCalled();
  });
});

describe('runReenrichment — idempotency', () => {
  it('second pass over same row (already match_raced from first pass) counts as match_raced not lml_error', async () => {
    // Simulate two passes: first enrich returns match_raced, second also match_raced
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1)])
      .mockResolvedValueOnce([makeRow(1)]) // second batch returns same row (simulates re-run)
      .mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match_raced');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.totals.match_raced).toBe(2);
    expect(result.totals.lml_error).toBe(0);
  });
});
