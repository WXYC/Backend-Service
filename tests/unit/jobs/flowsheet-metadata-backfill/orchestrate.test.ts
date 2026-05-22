/**
 * Unit tests for flowsheet-metadata-backfill orchestrate.ts.
 *
 * Pins five behaviors the historical drain depends on:
 *   1. The loadBatch SELECT carries the canonical filter (entry_type='track'
 *      + artist_name IS NOT NULL + metadata_attempt_at IS NULL + 60s race
 *      guard + id-cursor + ORDER BY id ASC + LIMIT batchSize).
 *   2. processRow returns 'lml_error' on a thrown lookup; the orchestrator
 *      counts it and continues. The row stays metadata_attempt_at IS NULL
 *      via `applyEnrichment` *not* being called on the error path.
 *   3. Match → enriched_match outcome; no-match → enriched_no_match outcome.
 *      Totals are bumped on the right counter.
 *   4. resolvePartitionFilter handles default (no-op), valid N/M, and
 *      throws on bad inputs.
 *   5. The id-cursor advances across batches and the loop terminates when
 *      a batch returns empty.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  BATCH_SIZE,
  LIVE_ACTIVITY_LOOKBACK_SECONDS,
  LIVE_ACTIVITY_PAUSE_MS,
  THROTTLE_MS,
  processRow,
  resolveBatchSize,
  resolveLiveActivityLookback,
  resolveLiveActivityPauseMs,
  resolvePartitionFilter,
  resolveThrottleMs,
  runBackfill,
  type CheckLiveActivityFn,
  type EnrichFn,
  type LookupFn,
} from '../../../../jobs/flowsheet-metadata-backfill/orchestrate';
import type { LookupResponse } from '@wxyc/lml-client';

type SqlLike = { sql?: string | string[]; queryChunks?: Array<string | { value?: string | string[] }> };
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
        if (typeof chunk.value === 'string') return chunk.value;
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

describe('resolvePartitionFilter', () => {
  it('returns no-op when neither env var set', () => {
    const got = resolvePartitionFilter(undefined, undefined);
    expect(got.sqlFragment).toBeNull();
    expect(got.description).toBe('partition=none');
  });

  it('returns mod-N filter for valid PARTITION_INDEX/PARTITION_COUNT', () => {
    const got = resolvePartitionFilter('1', '4');
    expect(got.sqlFragment).not.toBeNull();
    expect(got.description).toBe('partition=1/4');
    const rendered = renderSql(got.sqlFragment);
    expect(rendered).toMatch(/AND.*%/);
  });

  it('throws on PARTITION_COUNT=0', () => {
    expect(() => resolvePartitionFilter('0', '0')).toThrow(/PARTITION_COUNT/);
  });

  it('throws on PARTITION_INDEX out of range', () => {
    expect(() => resolvePartitionFilter('4', '4')).toThrow(/PARTITION_INDEX/);
    expect(() => resolvePartitionFilter('-1', '4')).toThrow(/PARTITION_INDEX/);
  });

  it('throws on non-integer inputs', () => {
    expect(() => resolvePartitionFilter('1', 'abc')).toThrow(/PARTITION_COUNT/);
    expect(() => resolvePartitionFilter('1.5', '4')).toThrow(/PARTITION_INDEX/);
  });
});

describe('resolveBatchSize', () => {
  it('falls back to BATCH_SIZE when env var is unset', () => {
    expect(resolveBatchSize(undefined)).toBe(BATCH_SIZE);
  });

  it('returns the parsed value for a valid positive integer', () => {
    expect(resolveBatchSize('1000')).toBe(1000);
    expect(resolveBatchSize('1')).toBe(1);
  });

  it('throws on zero, negative, non-integer, or garbage input', () => {
    expect(() => resolveBatchSize('0')).toThrow(/BACKFILL_BATCH_SIZE/);
    expect(() => resolveBatchSize('-100')).toThrow(/BACKFILL_BATCH_SIZE/);
    expect(() => resolveBatchSize('1.5')).toThrow(/BACKFILL_BATCH_SIZE/);
    expect(() => resolveBatchSize('abc')).toThrow(/BACKFILL_BATCH_SIZE/);
  });
});

describe('resolveThrottleMs', () => {
  it('falls back to THROTTLE_MS when env var is unset', () => {
    expect(resolveThrottleMs(undefined)).toBe(THROTTLE_MS);
  });

  it('accepts 0 (pilot/CI runs may want no inter-row sleep)', () => {
    expect(resolveThrottleMs('0')).toBe(0);
  });

  it('returns the parsed value for a positive integer', () => {
    expect(resolveThrottleMs('250')).toBe(250);
  });

  it('throws on negative, non-integer, or garbage input', () => {
    expect(() => resolveThrottleMs('-50')).toThrow(/BACKFILL_THROTTLE_MS/);
    expect(() => resolveThrottleMs('1.5')).toThrow(/BACKFILL_THROTTLE_MS/);
    expect(() => resolveThrottleMs('abc')).toThrow(/BACKFILL_THROTTLE_MS/);
  });
});

describe('resolveLiveActivityLookback', () => {
  it('falls back to LIVE_ACTIVITY_LOOKBACK_SECONDS when env var is unset', () => {
    expect(resolveLiveActivityLookback(undefined)).toBe(LIVE_ACTIVITY_LOOKBACK_SECONDS);
  });

  it('accepts 0 (operators can disable the cooperative pause for catch-up runs)', () => {
    expect(resolveLiveActivityLookback('0')).toBe(0);
  });

  it('returns the parsed value for a positive integer', () => {
    expect(resolveLiveActivityLookback('120')).toBe(120);
  });

  it('throws on negative, non-integer, or garbage input', () => {
    expect(() => resolveLiveActivityLookback('-1')).toThrow(/LIVE_ACTIVITY_LOOKBACK_SECONDS/);
    expect(() => resolveLiveActivityLookback('1.5')).toThrow(/LIVE_ACTIVITY_LOOKBACK_SECONDS/);
    expect(() => resolveLiveActivityLookback('abc')).toThrow(/LIVE_ACTIVITY_LOOKBACK_SECONDS/);
  });
});

describe('resolveLiveActivityPauseMs', () => {
  it('falls back to LIVE_ACTIVITY_PAUSE_MS when env var is unset', () => {
    expect(resolveLiveActivityPauseMs(undefined)).toBe(LIVE_ACTIVITY_PAUSE_MS);
  });

  it('accepts 0 (tests may want no pause)', () => {
    expect(resolveLiveActivityPauseMs('0')).toBe(0);
  });

  it('returns the parsed value for a positive integer', () => {
    expect(resolveLiveActivityPauseMs('15000')).toBe(15000);
  });

  it('throws on negative, non-integer, or garbage input', () => {
    expect(() => resolveLiveActivityPauseMs('-1')).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
    expect(() => resolveLiveActivityPauseMs('1.5')).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
    expect(() => resolveLiveActivityPauseMs('abc')).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
  });
});

describe('processRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const row = { id: 42, artist_name: 'Autechre', album_title: 'Confield', track_title: 'VI Scose Poise' };

  it('returns enriched_match and calls enrich on LML success-with-match', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResponse);
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');

    const outcome = await processRow(row, { lookup, enrich });

    expect(outcome).toBe('enriched_match');
    expect(lookup).toHaveBeenCalledWith('Autechre', 'Confield', 'VI Scose Poise');
    expect(enrich).toHaveBeenCalledWith(row, matchedResponse);
  });

  it('returns enriched_no_match and calls enrich on LML no-match', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResponse);
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_no_match');

    const outcome = await processRow(row, { lookup, enrich });

    expect(outcome).toBe('enriched_no_match');
    expect(enrich).toHaveBeenCalledWith(row, noMatchResponse);
  });

  it('returns lml_error and does NOT call enrich on LML throw (row stays retryable)', async () => {
    const lookup = jest.fn<LookupFn>().mockRejectedValue(new Error('LML 502'));
    const enrich = jest.fn<EnrichFn>();

    const outcome = await processRow(row, { lookup, enrich });

    expect(outcome).toBe('lml_error');
    // Critical: the row's metadata_attempt_at stays NULL because we never
    // call enrich. This is what makes #639 Phase 2's recurring sweep able
    // to re-attempt transient LML failures.
    expect(enrich).not.toHaveBeenCalled();
  });

  it('forwards undefined for null album_title / track_title (matches lml-fetch.ts contract)', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResponse);
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_no_match');
    const sparseRow = { id: 1, artist_name: 'Lone Anonymous', album_title: null, track_title: null };

    await processRow(sparseRow, { lookup, enrich });

    expect(lookup).toHaveBeenCalledWith('Lone Anonymous', undefined, undefined);
  });
});

describe('runBackfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResponse);
  const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');

  it('issues a SELECT carrying the canonical WHERE filter (entry_type, artist_name, marker, race guard, cursor, ORDER BY, LIMIT)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await runBackfill({ lookup, enrich, throttleMs: 0, liveActivityLookbackSeconds: 0 });

    const call = (db.execute as jest.Mock).mock.calls[0];
    expect(call).toBeDefined();
    const sql = renderSql(call?.[0]);
    expect(sql).toMatch(/"entry_type"\s*=\s*'track'/);
    expect(sql).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/"metadata_attempt_at"\s+IS\s+NULL/i);
    expect(sql).toMatch(/"add_time"\s*<\s*now\(\)\s*-\s*interval\s*'60 seconds'/i);
    expect(sql).toMatch(/"id"\s*>/);
    expect(sql).toMatch(/ORDER BY\s+"id"\s+ASC/i);
    expect(sql).toMatch(/LIMIT/i);
  });

  it('advances the id-cursor across batches and terminates on empty', async () => {
    const batch1 = [
      { id: 10, artist_name: 'a', album_title: null, track_title: null },
      { id: 20, artist_name: 'b', album_title: null, track_title: null },
    ];
    const batch2 = [{ id: 30, artist_name: 'c', album_title: null, track_title: null }];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch1).mockResolvedValueOnce(batch2).mockResolvedValueOnce([]);

    const result = await runBackfill({ lookup, enrich, throttleMs: 0, liveActivityLookbackSeconds: 0 });

    expect((db.execute as jest.Mock).mock.calls.length).toBe(3);
    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(3);
    expect(result.totals.lml_error).toBe(0);

    // The 2nd SELECT must paginate from id > 20 (the largest id of batch1).
    // The 3rd from id > 30.
    const sql2 = renderSql((db.execute as jest.Mock).mock.calls[1]?.[0]);
    const sql3 = renderSql((db.execute as jest.Mock).mock.calls[2]?.[0]);
    // Cursor values are passed as drizzle params, so they don't appear
    // literally in `sql.join('')` — they're in `values`. Pull them out.
    const values2 = ((db.execute as jest.Mock).mock.calls[1]?.[0] as { values?: unknown[] })?.values;
    const values3 = ((db.execute as jest.Mock).mock.calls[2]?.[0] as { values?: unknown[] })?.values;
    expect(values2).toContain(20);
    expect(values3).toContain(30);
    // Sanity: all three SQL strings carry the cursor predicate
    [sql2, sql3].forEach((s) => expect(s).toMatch(/"id"\s*>/));
  });

  it('counts lml_error when LML throws and continues processing', async () => {
    const batch = [
      { id: 10, artist_name: 'a', album_title: null, track_title: null },
      { id: 20, artist_name: 'b', album_title: null, track_title: null },
      { id: 30, artist_name: 'c', album_title: null, track_title: null },
    ];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

    const lookupFlaky = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce(matchedResponse)
      .mockRejectedValueOnce(new Error('LML 502'))
      .mockResolvedValueOnce(noMatchResponse);
    const enrichLocal = jest
      .fn<EnrichFn>()
      .mockResolvedValueOnce('enriched_match')
      .mockResolvedValueOnce('enriched_no_match');

    const result = await runBackfill({
      lookup: lookupFlaky,
      enrich: enrichLocal,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(1);
    expect(result.totals.enriched_no_match).toBe(1);
    expect(result.totals.lml_error).toBe(1);
    // enrich is called twice (once per non-error row) — the LML-throw row
    // skips enrich entirely so its metadata_attempt_at stays NULL.
    expect(enrichLocal).toHaveBeenCalledTimes(2);
  });

  it('exposes BATCH_SIZE and THROTTLE_MS constants for ops tuning', () => {
    expect(BATCH_SIZE).toBe(500);
    expect(THROTTLE_MS).toBe(100);
  });

  it('exposes LIVE_ACTIVITY_LOOKBACK_SECONDS and LIVE_ACTIVITY_PAUSE_MS for ops tuning', () => {
    expect(LIVE_ACTIVITY_LOOKBACK_SECONDS).toBe(60);
    expect(LIVE_ACTIVITY_PAUSE_MS).toBe(30_000);
  });

  it('defers a batch when checkLiveActivity returns true, then proceeds when it clears', async () => {
    // First two probes return true (DJ active), third clears.
    // Then loadBatch returns one row, then empty.
    const checkLiveActivity = jest
      .fn<CheckLiveActivityFn>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(false);

    const batch = [{ id: 99, artist_name: 'a', album_title: null, track_title: null }];
    (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

    const result = await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 0,
      checkLiveActivity,
    });

    // Three probes: two-true-then-false before the first batch, then one
    // probe before the (empty) terminal poll.
    expect(checkLiveActivity).toHaveBeenCalledTimes(4);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.enriched_match).toBe(1);
    // loadBatch was called only after the probe cleared; lookup was not
    // called during the deferral window.
    expect((db.execute as jest.Mock).mock.calls.length).toBe(2);
  });

  it('skips the cooperative-pause probe when liveActivityLookbackSeconds is 0', async () => {
    const checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
      liveActivityPauseMs: 0,
      checkLiveActivity,
    });

    // With lookback=0 the probe is bypassed entirely; no calls even though
    // the stub would have returned true.
    expect(checkLiveActivity).not.toHaveBeenCalled();
  });

  it('forwards liveActivityLookbackSeconds to checkLiveActivity so the probe window is tunable', async () => {
    const checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 120,
      liveActivityPauseMs: 0,
      checkLiveActivity,
    });

    expect(checkLiveActivity).toHaveBeenCalledWith(120);
  });

  it('counts enriched_match_raced separately from enriched_match', async () => {
    // Race scenario at the orchestrator level: enrich returns the
    // *_raced variant when 0 rows updated. The orchestrator must bump
    // the matching counter rather than treating it as a regular match.
    const batch = [
      { id: 10, artist_name: 'a', album_title: null, track_title: null },
      { id: 20, artist_name: 'b', album_title: null, track_title: null },
      { id: 30, artist_name: 'c', album_title: null, track_title: null },
    ];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

    const enrichWithRaces = jest
      .fn<EnrichFn>()
      .mockResolvedValueOnce('enriched_match')
      .mockResolvedValueOnce('enriched_match_raced')
      .mockResolvedValueOnce('enriched_no_match_raced');

    const result = await runBackfill({
      lookup,
      enrich: enrichWithRaces,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(1);
    expect(result.totals.enriched_match_raced).toBe(1);
    expect(result.totals.enriched_no_match).toBe(0);
    expect(result.totals.enriched_no_match_raced).toBe(1);
    expect(result.totals.lml_error).toBe(0);
  });
});
