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
  requestStop,
  __resetStopForTesting,
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

  it('returns the value when set to a valid past ISO timestamp', () => {
    expect(resolveCutoffTs(CUTOFF)).toBe(CUTOFF);
  });

  it('throws on garbage', () => {
    expect(() => resolveCutoffTs('not-a-date')).toThrow(/strict ISO 8601/);
    expect(() => resolveCutoffTs('yesterday')).toThrow(/strict ISO 8601/);
  });

  it('throws on non-strict-ISO formats Date.parse accepts but PG would reject (or interpret differently)', () => {
    // round-3 hardening: Date.parse accepts these, but they could shift
    // cohort semantics vs PG ::timestamptz.
    expect(() => resolveCutoffTs('2026-6-16T17:53:53Z')).toThrow(/strict ISO 8601/);
    expect(() => resolveCutoffTs('2026/06/16 17:53:53')).toThrow(/strict ISO 8601/);
    expect(() => resolveCutoffTs('2026')).toThrow(/strict ISO 8601/);
    expect(() => resolveCutoffTs('2026-06-16')).toThrow(/strict ISO 8601/); // date-only
  });

  it('throws on out-of-range day that Date.parse silently normalizes', () => {
    // '2026-02-30' would normalize to '2026-03-02' under bare Date.parse;
    // our calendar-validation catches it explicitly.
    expect(() => resolveCutoffTs('2026-02-30T00:00:00Z')).toThrow(/out-of-range field/);
    expect(() => resolveCutoffTs('2026-06-31T00:00:00Z')).toThrow(/out-of-range field/);
    expect(() => resolveCutoffTs('2026-13-01T00:00:00Z')).toThrow(/out-of-range field/);
    expect(() => resolveCutoffTs('2026-06-16T25:00:00Z')).toThrow(/out-of-range field/);
  });

  it('accepts timezone-offset form (e.g. -07:00)', () => {
    expect(resolveCutoffTs('2026-06-16T10:53:53-07:00')).toBe('2026-06-16T10:53:53-07:00');
  });

  it('throws on a future timestamp (catches fat-finger year typos)', () => {
    expect(() => resolveCutoffTs('2099-01-01T00:00:00Z')).toThrow(/in the future/);
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

describe('runReenrichment — db_error catch arm (review-round-2)', () => {
  it('counts db_error and continues when enrich throws (transient PG failure)', async () => {
    // First row enrich throws (e.g. transient connection reset), second row succeeds
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue('match');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    // Critical: the run does NOT abort — both rows are scanned, one
    // counted as db_error, one as match.
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.db_error).toBe(1);
    expect(result.totals.match).toBe(1);
    expect(result.flipped).toBe(1);
  });
});

describe('runReenrichment — cooperative stop (SIGTERM)', () => {
  // Reset before AND after so the module-level stopRequested flag never
  // leaks into a subsequent describe block (e.g. loadBatch-retry tests
  // that would otherwise see stopRequested=true and exit before the
  // first batch).
  beforeEach(() => {
    __resetStopForTesting();
  });
  afterEach(() => {
    __resetStopForTesting();
  });

  it('exits between batches when requestStop() is called', async () => {
    // Two batches available; stop is requested before the second loads
    let batchCount = 0;
    (db.execute as jest.Mock).mockImplementation(() => {
      batchCount += 1;
      if (batchCount === 1) {
        return Promise.resolve([makeRow(1)]);
      }
      return Promise.resolve([makeRow(2)]);
    });

    const lookup = jest.fn<LookupFn>().mockImplementation(() => {
      // Request stop after the first row is processed
      requestStop();
      return Promise.resolve(noMatchResult());
    });
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    // First batch's single row processes; the loop checks stopRequested
    // before the second loadBatch and exits. Row 2 is never scanned.
    expect(result.totals.scanned).toBe(1);
  });
});

describe('runReenrichment — loadBatch retry on transient DB error', () => {
  // mockReset (not mockClear) wipes the previous test's mockImplementation
  // so we can fully control db.execute here. Also reset the global
  // stopRequested flag in case a prior SIGTERM test left it set.
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    __resetStopForTesting();
  });

  it('retries up to 3 times before succeeding', async () => {
    let attempts = 0;
    (db.execute as jest.Mock).mockImplementation(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error('transient connection reset'));
      }
      return Promise.resolve([]); // third attempt succeeds with empty → loop exits
    });

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(attempts).toBe(3);
    expect(result.totals.scanned).toBe(0);
  }, 30_000);

  it('propagates after exhausting retries', async () => {
    const err = new Error('sustained outage');
    (db.execute as jest.Mock).mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockRejectedValueOnce(err);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    await expect(
      runReenrichment({
        lookup,
        enrich,
        cutoffTs: CUTOFF,
        batchSize: 100,
        liveActivityLookbackSeconds: 0,
      })
    ).rejects.toThrow(/sustained outage/);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(3);
  }, 30_000);
});
