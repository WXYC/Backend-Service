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

import { db, type CheckLiveActivityFn } from '@wxyc/database';
import {
  BATCH_SIZE,
  THROTTLE_MS,
  processRow,
  resolveBatchSize,
  resolveLiveActivityLookback,
  resolveLiveActivityPauseMs,
  resolvePartitionFilter,
  resolveThrottleMs,
  runBackfill,
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

// LookupFn now returns `{ response, cacheHit }` (LookupResult) instead of
// the bare LookupResponse — so the orchestrator can skip the per-row LML
// throttle on hits. Tests wrap the responses with these helpers.
const matchedResult = (cacheHit = false) => ({ response: matchedResponse, cacheHit });
const noMatchResult = (cacheHit = false) => ({ response: noMatchResponse, cacheHit });

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
  it('falls back to the shared 60s default when env var is unset', () => {
    expect(resolveLiveActivityLookback(undefined)).toBe(60);
  });

  it('falls back to the default when env var is empty or whitespace-only', () => {
    expect(resolveLiveActivityLookback('')).toBe(60);
    expect(resolveLiveActivityLookback('   ')).toBe(60);
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
  it('falls back to the shared 30s default when env var is unset', () => {
    expect(resolveLiveActivityPauseMs(undefined)).toBe(30_000);
  });

  it('falls back to the default when env var is empty or whitespace-only', () => {
    expect(resolveLiveActivityPauseMs('')).toBe(30_000);
    expect(resolveLiveActivityPauseMs('   ')).toBe(30_000);
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

  const row = {
    id: 42,
    artist_name: 'Autechre',
    album_title: 'Confield',
    track_title: 'VI Scose Poise',
    album_id: null,
  };

  it('returns enriched_match + cacheHit=false on LML success-with-match (miss path)', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');

    const result = await processRow(row, { lookup, enrich });

    expect(result).toEqual({ outcome: 'enriched_match', cacheHit: false });
    expect(lookup).toHaveBeenCalledWith('Autechre', 'Confield', 'VI Scose Poise');
    expect(enrich).toHaveBeenCalledWith(row, matchedResponse);
  });

  it('forwards cacheHit=true from the lookup result so the orchestrator can skip throttle', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(true));
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');

    const result = await processRow(row, { lookup, enrich });

    expect(result).toEqual({ outcome: 'enriched_match', cacheHit: true });
  });

  it('returns enriched_no_match and calls enrich on LML no-match', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult(false));
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_no_match');

    const result = await processRow(row, { lookup, enrich });

    expect(result).toEqual({ outcome: 'enriched_no_match', cacheHit: false });
    expect(enrich).toHaveBeenCalledWith(row, noMatchResponse);
  });

  it('returns lml_error and does NOT call enrich on LML throw (row stays retryable)', async () => {
    const lookup = jest.fn<LookupFn>().mockRejectedValue(new Error('LML 502'));
    const enrich = jest.fn<EnrichFn>();

    const result = await processRow(row, { lookup, enrich });

    expect(result).toEqual({ outcome: 'lml_error', cacheHit: false });
    // Critical: the row's metadata_attempt_at stays NULL because we never
    // call enrich. This is what makes #639 Phase 2's recurring sweep able
    // to re-attempt transient LML failures.
    expect(enrich).not.toHaveBeenCalled();
  });

  it('returns enrich_error (not a throw) when enrich rejects, so a single bad row cannot abort the run', async () => {
    // BS#1011 poison-pill jam: a mojibake album title synthesizes a Bandcamp
    // search URL that overflows flowsheet.bandcamp_url varchar(512); the
    // UPDATE throws `value too long`. Before the fix the throw bubbled past
    // processRow → main → exit 1, and because the failed UPDATE never stamped
    // metadata_attempt_at the id-cursor re-selected the same row every run —
    // a permanent stall. processRow must map the enrich throw to enrich_error
    // (mirroring the lml_error catch) instead of propagating it.
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
    const enrich = jest.fn<EnrichFn>().mockRejectedValue(new Error('value too long for type character varying(512)'));

    const result = await processRow(row, { lookup, enrich });

    expect(result).toEqual({ outcome: 'enrich_error', cacheHit: false });
    expect(enrich).toHaveBeenCalledWith(row, matchedResponse);
  });

  it('forwards cacheHit through the enrich_error path (the lookup succeeded, so a cached hit still skips throttle)', async () => {
    // Unlike lml_error (lookup itself threw → cacheHit forced false so the
    // next LML attempt is still spaced), an enrich failure happens *after* a
    // successful lookup, so the lookup's real cacheHit is meaningful and must
    // flow through — a cache hit made no LML call and shouldn't be throttled.
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(true));
    const enrich = jest.fn<EnrichFn>().mockRejectedValue(new Error('DB write failed'));

    const result = await processRow(row, { lookup, enrich });

    expect(result).toEqual({ outcome: 'enrich_error', cacheHit: true });
  });

  it('logs a non-Error enrich throw with a stringified message (not undefined)', async () => {
    // A non-Error rejection (`throw 'string'`, `throw { code }`) must still
    // surface a message on the enrich_error log line — `(error as Error).message`
    // would emit undefined and the JSON logger would drop the key, leaving
    // operators with no signal (mirrors readCacheFields's guard).
    const initLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).initLogger;
    const closeLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).closeLogger;
    initLogger({ repo: 'Backend-Service', tool: 'test', runId: 'run-id-enrich-nonerror' });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
      const enrich = jest.fn<EnrichFn>().mockRejectedValue('value too long for type character varying(512)');

      const result = await processRow(row, { lookup, enrich });

      expect(result).toEqual({ outcome: 'enrich_error', cacheHit: false });
      const enrichErrorLine = writeSpy.mock.calls
        .map((args) => String(args[0]))
        .find((l) => l.includes('"step":"enrich_error"'));
      if (!enrichErrorLine) throw new Error('expected an enrich_error log line');
      const parsed = JSON.parse(enrichErrorLine.trim());
      expect(parsed.error_message).toBe('value too long for type character varying(512)');
    } finally {
      writeSpy.mockRestore();
      await closeLogger();
    }
  });

  it('forwards undefined for null album_title / track_title (matches lml-fetch.ts contract)', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult(false));
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_no_match');
    const sparseRow = { id: 1, artist_name: 'Lone Anonymous', album_title: null, track_title: null, album_id: null };

    await processRow(sparseRow, { lookup, enrich });

    expect(lookup).toHaveBeenCalledWith('Lone Anonymous', undefined, undefined);
  });
});

describe('runBackfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
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
    // BS#1027: SELECT must project album_id so the enricher can branch on
    // linked vs unlinked and UPSERT album_metadata instead of inline-writing
    // to flowsheet.
    expect(sql).toMatch(/"album_id"/);
  });

  it('advances the id-cursor across batches and terminates on empty', async () => {
    const batch1 = [
      { id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null },
      { id: 20, artist_name: 'b', album_title: null, track_title: null, album_id: null },
    ];
    const batch2 = [{ id: 30, artist_name: 'c', album_title: null, track_title: null, album_id: null }];

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
      { id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null },
      { id: 20, artist_name: 'b', album_title: null, track_title: null, album_id: null },
      { id: 30, artist_name: 'c', album_title: null, track_title: null, album_id: null },
    ];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

    const lookupFlaky = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce(matchedResult(false))
      .mockRejectedValueOnce(new Error('LML 502'))
      .mockResolvedValueOnce(noMatchResult(false));
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

  it('counts enrich_error and drains the rest of the batch when one row’s enrich throws (BS#1011 poison-pill jam regression)', async () => {
    // The wedge that stalled the BS#1011 drain for ~2.5 weeks: a mojibake
    // album title overflowed flowsheet.bandcamp_url varchar(512), the enrich
    // UPDATE threw, and the throw aborted the whole run. The failed row never
    // got its metadata_attempt_at marker, so the next run re-selected it as
    // the smallest pending id and crashed again — zero forward progress. This
    // pins that the poison row is now isolated (counted as enrich_error), the
    // id-cursor advances past it, and the remaining rows in the batch drain.
    const batch = [
      { id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null },
      { id: 20, artist_name: 'b', album_title: 'mojibake', track_title: null, album_id: null },
      { id: 30, artist_name: 'c', album_title: null, track_title: null, album_id: null },
    ];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

    const enrichPoison = jest
      .fn<EnrichFn>()
      .mockResolvedValueOnce('enriched_match')
      .mockRejectedValueOnce(new Error('value too long for type character varying(512)'))
      .mockResolvedValueOnce('enriched_no_match');

    const result = await runBackfill({
      lookup,
      enrich: enrichPoison,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
    });

    // Run completes normally (no exit 1). All three rows scanned; the poison
    // row lands in its own bucket while the other two enrich as usual.
    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(1);
    expect(result.totals.enriched_no_match).toBe(1);
    expect(result.totals.enrich_error).toBe(1);
    // enrich is attempted on all three (the lookup succeeded for each) — the
    // poison row is only skipped *after* its DB write throws, not before.
    expect(enrichPoison).toHaveBeenCalledTimes(3);

    // The terminal (empty) poll must paginate from id > 30 — proof the cursor
    // advanced *past* the poison row (id 20) rather than jamming on it.
    const terminalPoll = (db.execute as jest.Mock).mock.calls[1]?.[0] as { values?: unknown[] };
    expect(terminalPoll?.values).toContain(30);
  });

  it('exposes BATCH_SIZE and THROTTLE_MS constants for ops tuning', () => {
    expect(BATCH_SIZE).toBe(500);
    expect(THROTTLE_MS).toBe(100);
  });

  it('default resolvers produce the shared 60s lookback / 30s pause', () => {
    expect(resolveLiveActivityLookback(undefined)).toBe(60);
    expect(resolveLiveActivityPauseMs(undefined)).toBe(30_000);
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

    const batch = [{ id: 99, artist_name: 'a', album_title: null, track_title: null, album_id: null }];
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

  describe('cache stats injection + cache-hit throttle skip (peer ticket to BS#1011)', () => {
    // The (artist, album) dedup cache lives in lml-fetch.ts; the orchestrator
    // gets a `cacheStats` injection so the batch_done log line can emit
    // `cache_hits` / `cache_misses` / `cache_size` / `cache_overwrites` as
    // flat fields alongside the totals.
    //
    // The cache-hit signal flows BACK from the lookup (LookupResult.cacheHit)
    // up through processRow so the per-row loop can skip THROTTLE_MS on hits.
    //
    // All tests put their spyOn(process.stdout, 'write').mockRestore() in
    // finally so a failed assertion can't leak the spy into subsequent tests.

    type CacheStats = { size: number; hits: number; misses: number; overwrites: number };

    it('emits cache_* fields in batch_done when cacheStats is provided', async () => {
      const initLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).initLogger;
      const closeLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).closeLogger;
      initLogger({ repo: 'Backend-Service', tool: 'test', runId: 'run-id-1' });
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      try {
        const batch = [
          { id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null },
          { id: 20, artist_name: 'b', album_title: null, track_title: null, album_id: null },
        ];
        (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

        const cacheStats = jest.fn<() => CacheStats>().mockReturnValue({ size: 1, hits: 1, misses: 1, overwrites: 0 });

        await runBackfill({ lookup, enrich, throttleMs: 0, liveActivityLookbackSeconds: 0, cacheStats });

        const stdoutLines = writeSpy.mock.calls.map((args) => String(args[0]));
        const batchDoneLine = stdoutLines.find((l) => l.includes('"step":"batch_done"'));
        if (!batchDoneLine) throw new Error('expected a batch_done log line');
        const parsed = JSON.parse(batchDoneLine.trim());
        expect(parsed.cache_hits).toBe(1);
        expect(parsed.cache_misses).toBe(1);
        expect(parsed.cache_size).toBe(1);
        expect(parsed.cache_overwrites).toBe(0);
        // Existing totals are still flat keys, not nested under a `cache` object.
        expect(parsed.scanned).toBe(2);
        expect(parsed.enriched_match).toBe(2);

        const finishedLine = stdoutLines.find((l) => l.includes('"step":"finished"'));
        if (!finishedLine) throw new Error('expected a finished log line');
        const parsedFinished = JSON.parse(finishedLine.trim());
        expect(parsedFinished.cache_hits).toBe(1);
        expect(parsedFinished.cache_misses).toBe(1);
        expect(parsedFinished.cache_size).toBe(1);
        expect(parsedFinished.cache_overwrites).toBe(0);

        // cacheStats should be invoked once per batch_done plus once on finished.
        expect(cacheStats).toHaveBeenCalledTimes(2);
      } finally {
        writeSpy.mockRestore();
        await closeLogger();
      }
    });

    it('omits cache_* fields when cacheStats is not provided (back-compat)', async () => {
      const initLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).initLogger;
      const closeLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).closeLogger;
      initLogger({ repo: 'Backend-Service', tool: 'test', runId: 'run-id-2' });
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      try {
        const batch = [{ id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null }];
        (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

        await runBackfill({ lookup, enrich, throttleMs: 0, liveActivityLookbackSeconds: 0 });

        const batchDoneLine = writeSpy.mock.calls
          .map((args) => String(args[0]))
          .find((l) => l.includes('"step":"batch_done"'));
        if (!batchDoneLine) throw new Error('expected a batch_done log line');
        const parsed = JSON.parse(batchDoneLine.trim());
        expect(parsed.cache_hits).toBeUndefined();
        expect(parsed.cache_misses).toBeUndefined();
        expect(parsed.cache_size).toBeUndefined();
        expect(parsed.cache_overwrites).toBeUndefined();
      } finally {
        writeSpy.mockRestore();
        await closeLogger();
      }
    });

    it.each<[string, unknown, string]>([
      ['Error', new Error('cache stats are unavailable'), 'cache stats are unavailable'],
      ['plain string', 'cache stats string thrown', 'cache stats string thrown'],
      ['plain object', { code: 'X' }, '[object Object]'],
    ])(
      'catches %s throws from cacheStats and emits cache_stats_error instead of aborting',
      async (_label, thrown, expectedMessage) => {
        // Observability failure must not wipe a successful batch.
        // applyEnrichment has already committed; we want a degraded
        // batch_done log line, not an exit 1. Non-Error throws must also
        // surface a message — `(err as Error).message` would emit
        // undefined and JSON.stringify would drop the key.
        const initLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).initLogger;
        const closeLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).closeLogger;
        initLogger({ repo: 'Backend-Service', tool: 'test', runId: `run-id-throw-${_label}` });
        const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

        try {
          const batch = [{ id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null }];
          (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

          const cacheStats = jest.fn<() => CacheStats>().mockImplementation(() => {
            throw thrown;
          });

          const result = await runBackfill({
            lookup,
            enrich,
            throttleMs: 0,
            liveActivityLookbackSeconds: 0,
            cacheStats,
          });

          // Run completes normally; totals were committed per row.
          expect(result.totals.scanned).toBe(1);
          expect(result.totals.enriched_match).toBe(1);

          const batchDoneLine = writeSpy.mock.calls
            .map((args) => String(args[0]))
            .find((l) => l.includes('"step":"batch_done"'));
          if (!batchDoneLine) throw new Error('expected a batch_done log line even when cacheStats throws');
          const parsed = JSON.parse(batchDoneLine.trim());
          expect(parsed.cache_stats_error).toBe(expectedMessage);
          expect(parsed.cache_hits).toBeUndefined();
        } finally {
          writeSpy.mockRestore();
          await closeLogger();
        }
      }
    );

    it('skips THROTTLE_MS sleep on cache hits (counted by setTimeout invocations, no wall-clock)', async () => {
      // The throttle exists to space LML calls. A cache hit makes no LML
      // call, so sleeping after one is wall-clock waste. Pinned by
      // counting setTimeout(_, throttleMs) invocations rather than
      // measuring elapsed time, so the test is deterministic regardless
      // of CI load / event-loop jitter / fake-vs-real-timer interactions
      // in sibling tests.
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      try {
        const batch = [
          { id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null },
          { id: 20, artist_name: 'b', album_title: null, track_title: null, album_id: null },
          { id: 30, artist_name: 'c', album_title: null, track_title: null, album_id: null },
          { id: 40, artist_name: 'd', album_title: null, track_title: null, album_id: null },
        ];
        (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

        // 1 miss + 3 hits → exactly 1 throttle sleep, not 4.
        const mixedLookup = jest
          .fn<LookupFn>()
          .mockResolvedValueOnce(matchedResult(false))
          .mockResolvedValueOnce(matchedResult(true))
          .mockResolvedValueOnce(matchedResult(true))
          .mockResolvedValueOnce(matchedResult(true));

        const THROTTLE = 7; // unique value so we can filter the spy
        await runBackfill({
          lookup: mixedLookup,
          enrich,
          throttleMs: THROTTLE,
          liveActivityLookbackSeconds: 0,
        });

        const throttleCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === THROTTLE);
        expect(throttleCalls).toHaveLength(1);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  it('counts enriched_match_raced separately from enriched_match', async () => {
    // Race scenario at the orchestrator level: enrich returns the
    // *_raced variant when 0 rows updated. The orchestrator must bump
    // the matching counter rather than treating it as a regular match.
    const batch = [
      { id: 10, artist_name: 'a', album_title: null, track_title: null, album_id: null },
      { id: 20, artist_name: 'b', album_title: null, track_title: null, album_id: null },
      { id: 30, artist_name: 'c', album_title: null, track_title: null, album_id: null },
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
