/**
 * Unit tests for flowsheet-metadata-backfill orchestrate.ts.
 *
 * Pins five behaviors the historical drain depends on (BS#1591 shape: a
 * play-priority work-list materialized once per run, drained by a
 * monotonic array cursor — see worklist.test.ts for the work-list SQL):
 *   1. Rows are processed in work-list (play-descending) order; each batch
 *      slice loads by id-array with a `metadata_attempt_at IS NULL`
 *      re-check and re-orders results to work-list order.
 *   2. processRow returns 'lml_error' on a thrown lookup; the orchestrator
 *      counts it and continues. The row stays metadata_attempt_at IS NULL
 *      via `applyEnrichment` *not* being called on the error path — and the
 *      no-wedge test pins that it is never re-selected within the run.
 *   3. Match → enriched_match outcome; no-match → enriched_no_match outcome.
 *      Totals are bumped on the right counter; below_floor_skipped and
 *      stale_skipped surface in totals and log lines.
 *   4. resolvePartitionFilter / resolvePlayFloor / resolveFloorRecencyDays
 *      handle defaults, valid input, and throw on bad input.
 *   5. The array cursor advances unconditionally and the loop terminates
 *      when the work-list is exhausted (no terminal empty poll).
 */
import { jest } from '@jest/globals';

import { db, type CheckLiveActivityFn } from '@wxyc/database';
import {
  BATCH_SIZE,
  FLOOR_RECENCY_DAYS_DEFAULT,
  PLAY_FLOOR_DEFAULT,
  THROTTLE_MS,
  isPermanentEnrichError,
  processRow,
  resolveBatchSize,
  resolveFloorRecencyDays,
  resolveLiveActivityLookback,
  resolveLiveActivityPauseMs,
  resolvePartitionFilter,
  resolvePlayFloor,
  resolveThrottleMs,
  runBackfill,
  type EnrichFn,
  type LookupFn,
  type StampDeadLetterFn,
} from '../../../../jobs/flowsheet-metadata-backfill/orchestrate';
import type { BuildWorkListFn, WorkList } from '../../../../jobs/flowsheet-metadata-backfill/worklist';
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

describe('isPermanentEnrichError (BS#1562 SQLSTATE classification)', () => {
  // A "permanent" enrich failure is one re-running the same row will always
  // reproduce: SQLSTATE class 22 (data exception — includes 22001 varchar
  // overflow, the mojibake-title poison rows) or class 23 (integrity
  // constraint violation). Everything else — deadlock, serialization,
  // connection drop, or an SQLSTATE we can't read — is treated as transient
  // (retryable). Fail safe toward retry, never toward silent give-up.
  //
  // The caught error is a drizzle wrapper; postgres-js puts the SQLSTATE on
  // `error.cause.code`, falling back to `error.code`.
  const withCode = (code: unknown): Error => Object.assign(new Error('db error'), { code });
  const withCauseCode = (code: unknown): Error => Object.assign(new Error('drizzle wrapper'), { cause: { code } });

  it('classifies class-22 (data exception) as permanent — cause.code path', () => {
    expect(isPermanentEnrichError(withCauseCode('22001'))).toBe(true); // string_data_right_truncation
    expect(isPermanentEnrichError(withCauseCode('22007'))).toBe(true); // invalid_datetime_format
  });

  it('classifies class-23 (integrity constraint violation) as permanent', () => {
    expect(isPermanentEnrichError(withCauseCode('23505'))).toBe(true); // unique_violation
    expect(isPermanentEnrichError(withCauseCode('23502'))).toBe(true); // not_null_violation
  });

  it('reads the SQLSTATE off error.code when there is no cause', () => {
    expect(isPermanentEnrichError(withCode('22001'))).toBe(true);
    expect(isPermanentEnrichError(withCode('40P01'))).toBe(false);
  });

  it('prefers cause.code over a top-level code (drizzle wrapper shape)', () => {
    const wrapped = Object.assign(new Error('wrapper'), { code: '40P01', cause: { code: '22001' } });
    expect(isPermanentEnrichError(wrapped)).toBe(true);
  });

  it('classifies transient failures (deadlock, serialization) as NOT permanent', () => {
    expect(isPermanentEnrichError(withCauseCode('40P01'))).toBe(false); // deadlock_detected
    expect(isPermanentEnrichError(withCauseCode('40001'))).toBe(false); // serialization_failure
    expect(isPermanentEnrichError(withCauseCode('08006'))).toBe(false); // connection_failure
  });

  it('treats an undeterminable code as transient (fail safe toward retry)', () => {
    expect(isPermanentEnrichError(new Error('no code at all'))).toBe(false);
    expect(isPermanentEnrichError(withCauseCode(undefined))).toBe(false);
    expect(isPermanentEnrichError(withCode(12345))).toBe(false); // non-string code
    expect(isPermanentEnrichError('just a string')).toBe(false);
    expect(isPermanentEnrichError(null)).toBe(false);
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

  const permanentError = () =>
    Object.assign(new Error('value too long for type character varying(512)'), {
      cause: { code: '22001' },
    });
  const transientError = () => Object.assign(new Error('deadlock detected'), { cause: { code: '40P01' } });

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

  it('dead-letters a permanent enrich failure (class-22 overflow): stamps the marker so the row leaves the pending cohort', async () => {
    // BS#1562: the mojibake-title poison rows overflow bandcamp_url
    // varchar(512) → SQLSTATE 22001 every run. Stamping metadata_attempt_at
    // removes them from the `metadata_attempt_at IS NULL` cohort so BS#1011's
    // "cohort == 0" retire criterion can actually fire.
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
    const enrich = jest.fn<EnrichFn>().mockRejectedValue(permanentError());
    const stampDeadLetter = jest.fn<StampDeadLetterFn>().mockResolvedValue();

    const result = await processRow(row, { lookup, enrich, stampDeadLetter });

    expect(result).toEqual({ outcome: 'enrich_error', cacheHit: false });
    expect(stampDeadLetter).toHaveBeenCalledWith(row.id);
  });

  it('does NOT dead-letter a transient enrich failure (deadlock 40P01): row stays retryable', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
    const enrich = jest.fn<EnrichFn>().mockRejectedValue(transientError());
    const stampDeadLetter = jest.fn<StampDeadLetterFn>().mockResolvedValue();

    const result = await processRow(row, { lookup, enrich, stampDeadLetter });

    expect(result).toEqual({ outcome: 'enrich_error', cacheHit: false });
    // No stamp → metadata_attempt_at stays NULL → next sweep retries it.
    expect(stampDeadLetter).not.toHaveBeenCalled();
  });

  it('does NOT dead-letter an undeterminable-code enrich failure (fail safe toward retry)', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
    const enrich = jest.fn<EnrichFn>().mockRejectedValue(new Error('no SQLSTATE here'));
    const stampDeadLetter = jest.fn<StampDeadLetterFn>().mockResolvedValue();

    const result = await processRow(row, { lookup, enrich, stampDeadLetter });

    expect(result).toEqual({ outcome: 'enrich_error', cacheHit: false });
    expect(stampDeadLetter).not.toHaveBeenCalled();
  });

  it('does not throw when the dead-letter stamp itself rejects (cursor must still advance)', async () => {
    // The stamp helper is best-effort; even if the injected stamp rejects,
    // processRow must resolve with enrich_error, never re-throw.
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
    const enrich = jest.fn<EnrichFn>().mockRejectedValue(permanentError());
    const stampDeadLetter = jest.fn<StampDeadLetterFn>().mockRejectedValue(new Error('stamp failed too'));

    await expect(processRow(row, { lookup, enrich, stampDeadLetter })).resolves.toEqual({
      outcome: 'enrich_error',
      cacheHit: false,
    });
  });

  it('records dead_lettered on the enrich_error log line (permanent → true, transient → false)', async () => {
    const initLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).initLogger;
    const closeLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).closeLogger;
    initLogger({ repo: 'Backend-Service', tool: 'test', runId: 'run-id-dead-letter' });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
      const stampDeadLetter = jest.fn<StampDeadLetterFn>().mockResolvedValue();

      const parseEnrichErrorLine = () => {
        const line = writeSpy.mock.calls
          .map((args) => String(args[0]))
          .reverse()
          .find((l) => l.includes('"step":"enrich_error"'));
        if (!line) throw new Error('expected an enrich_error log line');
        return JSON.parse(line.trim());
      };

      await processRow(row, {
        lookup,
        enrich: jest.fn<EnrichFn>().mockRejectedValue(permanentError()),
        stampDeadLetter,
      });
      expect(parseEnrichErrorLine().dead_lettered).toBe(true);

      writeSpy.mockClear();
      await processRow(row, {
        lookup,
        enrich: jest.fn<EnrichFn>().mockRejectedValue(transientError()),
        stampDeadLetter,
      });
      expect(parseEnrichErrorLine().dead_lettered).toBe(false);
    } finally {
      writeSpy.mockRestore();
      await closeLogger();
    }
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

describe('resolvePlayFloor (BS#1591)', () => {
  it('falls back to PLAY_FLOOR_DEFAULT (5) when env var is unset or empty', () => {
    expect(PLAY_FLOOR_DEFAULT).toBe(5);
    expect(resolvePlayFloor(undefined)).toBe(5);
    expect(resolvePlayFloor('')).toBe(5);
    expect(resolvePlayFloor('   ')).toBe(5);
  });

  it('accepts 0 (disables the non-library play-floor)', () => {
    expect(resolvePlayFloor('0')).toBe(0);
  });

  it('returns the parsed value for a positive integer', () => {
    expect(resolvePlayFloor('12')).toBe(12);
  });

  it('throws on negative, non-integer, or garbage input', () => {
    expect(() => resolvePlayFloor('-1')).toThrow(/BACKFILL_NONLIBRARY_PLAY_FLOOR/);
    expect(() => resolvePlayFloor('1.5')).toThrow(/BACKFILL_NONLIBRARY_PLAY_FLOOR/);
    expect(() => resolvePlayFloor('abc')).toThrow(/BACKFILL_NONLIBRARY_PLAY_FLOOR/);
  });
});

describe('resolveFloorRecencyDays (BS#1591 / decision 5)', () => {
  it('falls back to FLOOR_RECENCY_DAYS_DEFAULT (7) when env var is unset or empty', () => {
    expect(FLOOR_RECENCY_DAYS_DEFAULT).toBe(7);
    expect(resolveFloorRecencyDays(undefined)).toBe(7);
    expect(resolveFloorRecencyDays('')).toBe(7);
  });

  it('accepts 0 (disables the recency exemption)', () => {
    expect(resolveFloorRecencyDays('0')).toBe(0);
  });

  it('returns the parsed value for a positive integer', () => {
    expect(resolveFloorRecencyDays('14')).toBe(14);
  });

  it('throws on negative, non-integer, or garbage input', () => {
    expect(() => resolveFloorRecencyDays('-1')).toThrow(/BACKFILL_FLOOR_RECENCY_DAYS/);
    expect(() => resolveFloorRecencyDays('0.5')).toThrow(/BACKFILL_FLOOR_RECENCY_DAYS/);
    expect(() => resolveFloorRecencyDays('abc')).toThrow(/BACKFILL_FLOOR_RECENCY_DAYS/);
  });
});

describe('runBackfill (BS#1591 work-list drain)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult(false));
  const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');

  const rowFor = (id: number, artist = `artist-${id}`): EnrichRowFixture => ({
    id,
    artist_name: artist,
    album_title: null,
    track_title: null,
    album_id: null,
  });

  type EnrichRowFixture = {
    id: number;
    artist_name: string;
    album_title: string | null;
    track_title: string | null;
    album_id: number | null;
  };

  /** Build a WorkList fixture from [id, plays] pairs. */
  const makeWorkList = (
    entries: Array<[number, number]>,
    extra?: { pendingTotal?: number; belowFloorSkipped?: number }
  ): WorkList => ({
    ids: entries.map(([id]) => id),
    plays: entries.map(([, plays]) => plays),
    pendingTotal: extra?.pendingTotal ?? entries.length,
    belowFloorSkipped: extra?.belowFloorSkipped ?? 0,
  });

  const injectWorkList = (
    entries: Array<[number, number]>,
    extra?: { pendingTotal?: number; belowFloorSkipped?: number }
  ) => jest.fn<BuildWorkListFn>().mockResolvedValue(makeWorkList(entries, extra));

  it('consults the real work-list builder by default and early-exits on an empty pending cohort', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ pending_total: 0 }]);

    const result = await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
      playFloor: 5,
      floorRecencyDays: 7,
    });

    // Only the pending-count statement ran (buildWorkList's early exit);
    // no batch SELECT, no lookups.
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    expect(renderSql((db.execute as jest.Mock).mock.calls[0]?.[0])).toMatch(/COUNT\(\*\)/i);
    expect(result.totals.scanned).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('passes resolved floor / recency / partition into the work-list builder', async () => {
    const buildWorkList = injectWorkList([]);

    await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
      playFloor: 3,
      floorRecencyDays: 2,
      buildWorkList,
    });

    expect(buildWorkList).toHaveBeenCalledTimes(1);
    expect(buildWorkList).toHaveBeenCalledWith({ playFloor: 3, recencyDays: 2, partitionFilter: null });
  });

  it('processes the work-list in play-descending order across batch slices and terminates when exhausted', async () => {
    // Work-list order is (plays DESC, artist, id) — ids 30, 10, 20. With
    // batchSize=2 the slices are [30,10] then [20]. The first batch SELECT
    // deliberately returns rows OUT of work-list order to pin the in-batch
    // re-ordering (`= ANY` does not preserve order).
    const buildWorkList = injectWorkList([
      [30, 12],
      [10, 12],
      [20, 3],
    ]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10), rowFor(30)]).mockResolvedValueOnce([rowFor(20)]);

    const result = await runBackfill({
      lookup,
      enrich,
      batchSize: 2,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
    });

    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(3);
    // Rows processed in work-list order, not SELECT-return order.
    expect(lookup.mock.calls.map((call) => call[0])).toEqual(['artist-30', 'artist-10', 'artist-20']);

    // Each slice loads by id-array literal + the marker re-check; no ORDER
    // BY / cursor predicate anywhere (the work-list IS the order).
    expect((db.execute as jest.Mock).mock.calls.length).toBe(2);
    const sql1 = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(sql1).toMatch(/=\s*ANY\(/i);
    expect(sql1).toMatch(/::int\[\]/);
    expect(sql1).toMatch(/"metadata_attempt_at"\s+IS\s+NULL/i);
    expect(sql1).toMatch(/"album_id"/);
    expect(sql1).not.toMatch(/ORDER BY/i);
    const values1 = ((db.execute as jest.Mock).mock.calls[0]?.[0] as { values?: unknown[] })?.values;
    const values2 = ((db.execute as jest.Mock).mock.calls[1]?.[0] as { values?: unknown[] })?.values;
    expect(values1).toContain('{30,10}');
    expect(values2).toContain('{20}');
  });

  it('no-wedge: a failing row is never re-selected within the run; it stays for the next run (BS#1011 lineage)', async () => {
    // The hard-won BS#1011 property under the new ordering: an lml_error row
    // stays metadata_attempt_at IS NULL (deliberately retryable), so a naive
    // head-of-cohort re-SELECT would re-pick the same high-play failing row
    // forever. The materialized work-list makes that impossible — each id
    // appears exactly once and the array cursor only moves forward.
    const buildWorkList = injectWorkList([
      [10, 100],
      [20, 50],
    ]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10)]).mockResolvedValueOnce([rowFor(20)]);

    const flakyLookup = jest
      .fn<LookupFn>()
      .mockRejectedValueOnce(new Error('LML 502'))
      .mockResolvedValueOnce(matchedResult(false));

    const result = await runBackfill({
      lookup: flakyLookup,
      enrich,
      batchSize: 1,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
    });

    // The failing head row was attempted exactly once; the run terminated
    // normally with the failure counted.
    expect(flakyLookup).toHaveBeenCalledTimes(2);
    expect(flakyLookup.mock.calls[0]?.[0]).toBe('artist-10');
    expect(result.totals.lml_error).toBe(1);
    expect(result.totals.enriched_match).toBe(1);
    expect(result.totals.scanned).toBe(2);

    // And id 10 appears in exactly one batch SELECT — never re-selected.
    const allBatchLiterals = (db.execute as jest.Mock).mock.calls
      .map((call) => ((call[0] as { values?: unknown[] })?.values ?? []).filter((v) => typeof v === 'string'))
      .flat();
    expect(allBatchLiterals).toEqual(['{10}', '{20}']);
  });

  it('counts work-list ids that vanished before their batch load as stale_skipped (mid-run worker overlap)', async () => {
    // A row enriched by the live worker between work-list build and its
    // batch slice drops out of the `metadata_attempt_at IS NULL` re-check.
    // It must be counted (not silently absorbed) and must not reach LML.
    const buildWorkList = injectWorkList([
      [10, 9],
      [20, 8],
    ]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(20)]);

    const result = await runBackfill({
      lookup,
      enrich,
      batchSize: 2,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
    });

    expect(result.totals.stale_skipped).toBe(1);
    expect(result.totals.scanned).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('artist-20', undefined, undefined);
  });

  it('propagates below_floor_skipped into totals and emits worklist_built / batch_done / finished log fields', async () => {
    const initLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).initLogger;
    const closeLogger = (await import('../../../../jobs/flowsheet-metadata-backfill/logger')).closeLogger;
    initLogger({ repo: 'Backend-Service', tool: 'test', runId: 'run-id-below-floor' });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const buildWorkList = injectWorkList([[10, 9]], { pendingTotal: 8, belowFloorSkipped: 7 });
      (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10)]);

      const result = await runBackfill({
        lookup,
        enrich,
        throttleMs: 0,
        liveActivityLookbackSeconds: 0,
        playFloor: 5,
        floorRecencyDays: 7,
        buildWorkList,
      });

      expect(result.totals.below_floor_skipped).toBe(7);

      const lines = writeSpy.mock.calls.map((args) => String(args[0]));
      const parse = (step: string) => {
        const line = lines.find((l) => l.includes(`"step":"${step}"`));
        if (!line) throw new Error(`expected a ${step} log line`);
        return JSON.parse(line.trim());
      };

      const started = parse('started');
      expect(started.play_floor).toBe(5);
      expect(started.floor_recency_days).toBe(7);

      const built = parse('worklist_built');
      expect(built.worklist_size).toBe(1);
      expect(built.pending_total).toBe(8);
      expect(built.below_floor_skipped).toBe(7);
      expect(built.max_plays).toBe(9);
      expect(built.min_plays).toBe(9);
      expect(typeof built.build_ms).toBe('number');

      const batchDone = parse('batch_done');
      expect(batchDone.batch_plays_max).toBe(9);
      expect(batchDone.batch_plays_min).toBe(9);
      expect(batchDone.below_floor_skipped).toBe(7);

      const finished = parse('finished');
      expect(finished.below_floor_skipped).toBe(7);
      expect(finished.stale_skipped).toBe(0);
    } finally {
      writeSpy.mockRestore();
      await closeLogger();
    }
  });

  it('counts lml_error when LML throws and continues processing', async () => {
    const buildWorkList = injectWorkList([
      [10, 3],
      [20, 2],
      [30, 1],
    ]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10), rowFor(20), rowFor(30)]);

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
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
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
    // UPDATE threw, and the throw aborted the whole run. This pins that the
    // poison row is isolated (counted as enrich_error) and the remaining
    // rows in the batch drain; the no-wedge test above pins that it is not
    // re-selected within the run.
    const buildWorkList = injectWorkList([
      [10, 3],
      [20, 2],
      [30, 1],
    ]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10), rowFor(20), rowFor(30)]);

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
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
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
  });

  it('exposes the ops-tuning constants', () => {
    expect(BATCH_SIZE).toBe(500);
    expect(THROTTLE_MS).toBe(100);
    expect(PLAY_FLOOR_DEFAULT).toBe(5);
    expect(FLOOR_RECENCY_DAYS_DEFAULT).toBe(7);
  });

  it('default resolvers produce the shared 60s lookback / 30s pause', () => {
    expect(resolveLiveActivityLookback(undefined)).toBe(60);
    expect(resolveLiveActivityPauseMs(undefined)).toBe(30_000);
  });

  it('defers the work-list build and each batch when checkLiveActivity returns true, then proceeds when it clears', async () => {
    // First two probes return true (DJ active), third clears → work-list
    // builds. One more probe (false) gates the single batch slice.
    const checkLiveActivity = jest
      .fn<CheckLiveActivityFn>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(false);

    const buildWorkList = injectWorkList([[99, 4]]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(99)]);

    const result = await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 0,
      checkLiveActivity,
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
    });

    // Three probes before the build (two-true-then-false), one before the
    // only slice. The loop ends when the work-list is exhausted — there is
    // no terminal empty poll (and so no probe for one) anymore.
    expect(checkLiveActivity).toHaveBeenCalledTimes(4);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.enriched_match).toBe(1);
    // The build waited for the probe to clear.
    expect(buildWorkList.mock.invocationCallOrder[0]).toBeGreaterThan(checkLiveActivity.mock.invocationCallOrder[2]);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
  });

  it('skips the cooperative-pause probe when liveActivityLookbackSeconds is 0', async () => {
    const checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);
    const buildWorkList = injectWorkList([[10, 4]]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10)]);

    await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 0,
      liveActivityPauseMs: 0,
      checkLiveActivity,
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
    });

    // With lookback=0 the probe is bypassed entirely; no calls even though
    // the stub would have returned true.
    expect(checkLiveActivity).not.toHaveBeenCalled();
  });

  it('forwards liveActivityLookbackSeconds to checkLiveActivity so the probe window is tunable', async () => {
    const checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);
    const buildWorkList = injectWorkList([]);

    await runBackfill({
      lookup,
      enrich,
      throttleMs: 0,
      liveActivityLookbackSeconds: 120,
      liveActivityPauseMs: 0,
      checkLiveActivity,
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
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
        const buildWorkList = injectWorkList([
          [10, 3],
          [20, 2],
        ]);
        (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10), rowFor(20)]);

        const cacheStats = jest.fn<() => CacheStats>().mockReturnValue({ size: 1, hits: 1, misses: 1, overwrites: 0 });

        await runBackfill({
          lookup,
          enrich,
          throttleMs: 0,
          liveActivityLookbackSeconds: 0,
          cacheStats,
          playFloor: 5,
          floorRecencyDays: 7,
          buildWorkList,
        });

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
        const buildWorkList = injectWorkList([[10, 3]]);
        (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10)]);

        await runBackfill({
          lookup,
          enrich,
          throttleMs: 0,
          liveActivityLookbackSeconds: 0,
          playFloor: 5,
          floorRecencyDays: 7,
          buildWorkList,
        });

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
          const buildWorkList = injectWorkList([[10, 3]]);
          (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10)]);

          const cacheStats = jest.fn<() => CacheStats>().mockImplementation(() => {
            throw thrown;
          });

          const result = await runBackfill({
            lookup,
            enrich,
            throttleMs: 0,
            liveActivityLookbackSeconds: 0,
            cacheStats,
            playFloor: 5,
            floorRecencyDays: 7,
            buildWorkList,
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
        const buildWorkList = injectWorkList([
          [10, 4],
          [20, 3],
          [30, 2],
          [40, 1],
        ]);
        (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10), rowFor(20), rowFor(30), rowFor(40)]);

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
          playFloor: 5,
          floorRecencyDays: 7,
          buildWorkList,
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
    const buildWorkList = injectWorkList([
      [10, 3],
      [20, 2],
      [30, 1],
    ]);
    (db.execute as jest.Mock).mockResolvedValueOnce([rowFor(10), rowFor(20), rowFor(30)]);

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
      playFloor: 5,
      floorRecencyDays: 7,
      buildWorkList,
    });

    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(1);
    expect(result.totals.enriched_match_raced).toBe(1);
    expect(result.totals.enriched_no_match).toBe(0);
    expect(result.totals.enriched_no_match_raced).toBe(1);
    expect(result.totals.lml_error).toBe(0);
  });
});
