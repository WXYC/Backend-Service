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
  resolveWindowStartTs,
  resolveTimeWindow,
  resolveDryRun,
  resolveMaxConsecutiveSheds,
  MAX_CONSECUTIVE_SHEDS,
  resolveLiveActivityLookback,
  resolveLiveActivityPauseMs,
  requestStop,
  __resetStopForTesting,
} from '../../../../jobs/flowsheet-reenrichment/orchestrate';

/**
 * Render a drizzle `sql` template object to a string for substring
 * assertions. Under this repo's test mock (tests/__mocks__/drizzle-orm.ts),
 * `db.execute(sql\`...\`)`'s argument serializes to `{ sql: string[], values:
 * unknown[] }`, where `sql` is the literal template fragments and `values`
 * is the interpolated parameters in positional order — reconstruct the
 * rendered SQL by interleaving them (a bare `.join('')` of `sql` alone
 * silently drops every interpolated value, which is invisible only as long
 * as no assertion needs text that falls after an interpolation point).
 *
 * Each value can itself be a nested `sql.raw(...)` chunk (`{ raw: string }`
 * — e.g. the FLOWSHEET_TABLE identifier) or another nested `sql\`...\`\``
 * fragment (`{ sql, values }` again) — the BACKFILL_WINDOW_START_TS /
 * BACKFILL_CUTOFF_TS optional-clause pattern (`cond ? sql\`AND ...\` :
 * sql\`\``, BS#1823) produces exactly this nesting. Recurse where applicable.
 */
type SqlChunk = { sql?: string | string[]; values?: unknown[]; raw?: string };
const renderSql = (value: unknown): string => {
  const obj = value as SqlChunk | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) {
    const fragments = obj.sql;
    const values = obj.values ?? [];
    let out = '';
    for (let i = 0; i < fragments.length; i++) {
      out += fragments[i];
      if (i < values.length) out += renderValue(values[i]);
    }
    return out;
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};

/** Render a single interpolated value: scalars verbatim, nested SQL/raw fragments recursively. */
const renderValue = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as SqlChunk;
    if (typeof o.raw === 'string') return o.raw;
    if (Array.isArray(o.sql)) return renderSql(o);
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
// BS#1823 regression-window lower bound — matches the README's run example.
const WINDOW_START = '2026-07-22T00:00:00Z';
// BS#1998 incident window — the interval over which the 2026-08-03/04 LML
// breaker flap terminalized 26,387 rows. Matches the README's run example.
const INCIDENT_START = '2026-08-04T06:00:00Z';
const INCIDENT_END = '2026-08-04T23:00:00Z';

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

describe('resolveWindowStartTs', () => {
  // BS#1823: optional lower bound for the regression-window re-enrichment
  // run. Mirrors resolveCutoffTs's strict ISO 8601 + calendar validation
  // exactly (shared validator), but differs in two ways pinned below:
  // unset is valid (not required), and a future timestamp is not rejected.
  it('returns undefined when BACKFILL_WINDOW_START_TS is not set (optional, unlike cutoff)', () => {
    expect(resolveWindowStartTs(undefined)).toBeUndefined();
  });

  it('returns the value when set to a valid past ISO timestamp', () => {
    expect(resolveWindowStartTs(WINDOW_START)).toBe(WINDOW_START);
  });

  it('returns the value when set to a valid FUTURE ISO timestamp (not rejected, unlike cutoff)', () => {
    expect(resolveWindowStartTs('2099-01-01T00:00:00Z')).toBe('2099-01-01T00:00:00Z');
  });

  it('throws on garbage', () => {
    expect(() => resolveWindowStartTs('not-a-date')).toThrow(/strict ISO 8601/);
    expect(() => resolveWindowStartTs('yesterday')).toThrow(/strict ISO 8601/);
  });

  it('throws on non-strict-ISO formats Date.parse accepts but PG would reject (or interpret differently)', () => {
    expect(() => resolveWindowStartTs('2026-6-16T17:53:53Z')).toThrow(/strict ISO 8601/);
    expect(() => resolveWindowStartTs('2026/06/16 17:53:53')).toThrow(/strict ISO 8601/);
    expect(() => resolveWindowStartTs('2026')).toThrow(/strict ISO 8601/);
    expect(() => resolveWindowStartTs('2026-06-16')).toThrow(/strict ISO 8601/); // date-only
  });

  it('throws on out-of-range day that Date.parse silently normalizes', () => {
    expect(() => resolveWindowStartTs('2026-02-30T00:00:00Z')).toThrow(/out-of-range field/);
    expect(() => resolveWindowStartTs('2026-06-31T00:00:00Z')).toThrow(/out-of-range field/);
    expect(() => resolveWindowStartTs('2026-13-01T00:00:00Z')).toThrow(/out-of-range field/);
    expect(() => resolveWindowStartTs('2026-06-16T25:00:00Z')).toThrow(/out-of-range field/);
  });

  it('accepts timezone-offset form (e.g. -07:00)', () => {
    expect(resolveWindowStartTs('2026-06-16T10:53:53-07:00')).toBe('2026-06-16T10:53:53-07:00');
  });

  it('error message names BACKFILL_WINDOW_START_TS, not BACKFILL_CUTOFF_TS (same validator, distinct field)', () => {
    expect(() => resolveWindowStartTs('garbage')).toThrow(/BACKFILL_WINDOW_START_TS/);
  });
});

describe('resolveTimeWindow', () => {
  // BS#1823: composes the two optional bounds and enforces "at least one is
  // required" — the drain has no defined cohort with neither set.
  it('throws when neither BACKFILL_CUTOFF_TS nor BACKFILL_WINDOW_START_TS is set', () => {
    expect(() => resolveTimeWindow(undefined, undefined)).toThrow(/BACKFILL_CUTOFF_TS/);
    expect(() => resolveTimeWindow(undefined, undefined)).toThrow(/BACKFILL_WINDOW_START_TS/);
  });

  it("cutoff-only: resolves cutoffTs, leaves windowStartTs undefined (today's exact behavior preserved)", () => {
    expect(resolveTimeWindow(CUTOFF, undefined)).toEqual({ cutoffTs: CUTOFF, windowStartTs: undefined });
  });

  it('window-start-only: resolves windowStartTs, leaves cutoffTs undefined (no upper bound)', () => {
    expect(resolveTimeWindow(undefined, WINDOW_START)).toEqual({ cutoffTs: undefined, windowStartTs: WINDOW_START });
  });

  it('both set: resolves both bounds (intersection)', () => {
    expect(resolveTimeWindow(CUTOFF, WINDOW_START)).toEqual({ cutoffTs: CUTOFF, windowStartTs: WINDOW_START });
  });

  it('propagates resolveCutoffTs future-rejection when cutoff is set', () => {
    expect(() => resolveTimeWindow('2099-01-01T00:00:00Z', undefined)).toThrow(/in the future/);
  });

  it('a malformed BACKFILL_WINDOW_START_TS is rejected the same way a malformed cutoff is', () => {
    expect(() => resolveTimeWindow(CUTOFF, 'not-a-date')).toThrow(/strict ISO 8601/);
    expect(() => resolveTimeWindow(undefined, 'not-a-date')).toThrow(/strict ISO 8601/);
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

  // BS#2147: `0` (and every value below the 1000ms floor) used to sleep for
  // that literal duration between re-probes — `0` degrades the cooperative
  // pause into an unthrottled hot loop against RDS rather than disabling it.
  // The resolver now rejects the whole sub-floor interval at init;
  // `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` remains the sole disable knob.
  it.each(['0', '1', '999'])('rejects a sub-floor value (%s)', (raw) => {
    expect(() => resolveLiveActivityPauseMs(raw)).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
  });

  it('accepts the floor value', () => {
    expect(resolveLiveActivityPauseMs('1000')).toBe(1000);
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

  // BS#1823: regression-window re-enrichment adds an optional lower bound.
  it('window-start-only: SELECT carries add_time >= start and omits the upper bound', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await runReenrichment({
      lookup,
      enrich,
      windowStartTs: WINDOW_START,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    const firstSelectSql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(firstSelectSql).toMatch(/enriched_no_match/);
    expect(firstSelectSql).toMatch(/album_id.*IS NULL|IS NULL.*album_id/i);
    expect(firstSelectSql.toLowerCase()).toMatch(/artist_name.*is not null/);
    expect(firstSelectSql).toMatch(/add_time"\s*>=\s*/);
    expect(firstSelectSql).toContain(WINDOW_START);
    // No upper bound at all — the cutoff's `<` comparison must be absent.
    // (The id-cursor predicate uses a bare `>`, never `<`, so this is safe.)
    expect(firstSelectSql).not.toContain('<');
  });

  it('both bounds set: SELECT carries the intersection (add_time >= start AND add_time < cutoff)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      windowStartTs: WINDOW_START,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    const firstSelectSql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(firstSelectSql).toMatch(/add_time"\s*>=\s*/);
    expect(firstSelectSql).toMatch(/add_time"\s*<\s*/);
    expect(firstSelectSql).toContain(WINDOW_START);
    expect(firstSelectSql).toContain(CUTOFF);
  });

  it("cutoff-only (today's existing config): SELECT has no add_time >= lower bound", async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 100, liveActivityLookbackSeconds: 0 });

    const firstSelectSql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(firstSelectSql).not.toMatch(/add_time"\s*>=\s*/);
    expect(firstSelectSql).toMatch(/add_time"\s*<\s*/);
  });

  it('neither bound set: rejects before any DB call', async () => {
    const originalCutoff = process.env.BACKFILL_CUTOFF_TS;
    const originalWindowStart = process.env.BACKFILL_WINDOW_START_TS;
    delete process.env.BACKFILL_CUTOFF_TS;
    delete process.env.BACKFILL_WINDOW_START_TS;

    try {
      const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
      const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

      await expect(runReenrichment({ lookup, enrich, batchSize: 100, liveActivityLookbackSeconds: 0 })).rejects.toThrow(
        /At least one of BACKFILL_CUTOFF_TS/
      );
      expect(db.execute).not.toHaveBeenCalled();
    } finally {
      if (originalCutoff === undefined) delete process.env.BACKFILL_CUTOFF_TS;
      else process.env.BACKFILL_CUTOFF_TS = originalCutoff;
      if (originalWindowStart === undefined) delete process.env.BACKFILL_WINDOW_START_TS;
      else process.env.BACKFILL_WINDOW_START_TS = originalWindowStart;
    }
  });
});

/**
 * BS#1998: the 2026-08-03/04 breaker incident froze 26,387 rows spanning
 * add_time 2004→2026. They are NOT identifiable by add_time — the drain that
 * froze them was working the historical backlog — only by the `updated_at`
 * instant at which they were terminalized. This block pins the third and
 * fourth window bounds, keyed on `updated_at`, composed the same way BS#1823
 * composed the add_time pair.
 *
 * Why `updated_at` is a stable selector here despite being mutable: this
 * job's no-match arm writes nothing, so `updated_at` moves only for rows
 * that simultaneously leave the cohort via `metadata_status='enriched_match'`.
 * The predicate does not eat its own tail. (An unrelated writer touching a
 * cohort row WILL evict it — see the README's leakage note.)
 */
describe('runReenrichment — updated_at window (BS#1998)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updated-after only: SELECT carries updated_at >= and no updated_at upper bound', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await runReenrichment({
      lookup,
      enrich,
      updatedAfterTs: INCIDENT_START,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    const firstSelectSql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(firstSelectSql).toMatch(/updated_at"\s*>=\s*/);
    expect(firstSelectSql).toContain(INCIDENT_START);
    expect(firstSelectSql).not.toMatch(/updated_at"\s*<\s*/);
    // The add_time pair must stay absent — the two windows are independent.
    expect(firstSelectSql).not.toMatch(/add_time/);
  });

  it('both updated_at bounds: SELECT carries the incident window intersection', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await runReenrichment({
      lookup,
      enrich,
      updatedAfterTs: INCIDENT_START,
      updatedBeforeTs: INCIDENT_END,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    const firstSelectSql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(firstSelectSql).toMatch(/updated_at"\s*>=\s*/);
    expect(firstSelectSql).toMatch(/updated_at"\s*<\s*/);
    expect(firstSelectSql).toContain(INCIDENT_START);
    expect(firstSelectSql).toContain(INCIDENT_END);
  });

  // The BS#1998 run shape: the incident cohort spans the whole add_time
  // range, so it is selected by updated_at ALONE. This is the case that
  // would be impossible if the add_time pair were still mandatory.
  it('an updated_at bound alone satisfies the at-least-one-bound requirement', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await expect(
      runReenrichment({
        lookup,
        enrich,
        updatedAfterTs: INCIDENT_START,
        updatedBeforeTs: INCIDENT_END,
        batchSize: 100,
        liveActivityLookbackSeconds: 0,
      })
    ).resolves.toBeDefined();
    expect(db.execute).toHaveBeenCalled();
  });

  it('composes with the add_time pair: all four bounds land in one SELECT', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      windowStartTs: WINDOW_START,
      updatedAfterTs: INCIDENT_START,
      updatedBeforeTs: INCIDENT_END,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    const firstSelectSql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    for (const ts of [CUTOFF, WINDOW_START, INCIDENT_START, INCIDENT_END]) {
      expect(firstSelectSql).toContain(ts);
    }
  });

  it.each([
    ['updatedAfterTs', { updatedAfterTs: 'not-a-date' }],
    ['updatedBeforeTs', { updatedBeforeTs: '2026-02-30T00:00:00Z' }],
  ])('%s is validated with the same strictness as the add_time bounds', async (_name, override) => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    await expect(
      runReenrichment({ lookup, enrich, batchSize: 100, liveActivityLookbackSeconds: 0, ...override })
    ).rejects.toThrow(/strict ISO 8601|out-of-range field/);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

/**
 * BS#1998 review round 1. Each of these closes an operator-typo path that
 * silently produced a wrong run rather than an error.
 */
describe('updated_at window shape guards (BS#1998 review)', () => {
  it('rejects an upper bound standing alone — it selects the whole backlog, not a window', () => {
    expect(() => resolveTimeWindow(undefined, undefined, undefined, INCIDENT_END)).toThrow(
      /BACKFILL_UPDATED_BEFORE_TS was set without BACKFILL_UPDATED_AFTER_TS/
    );
  });

  it('rejects a transposed window rather than silently reporting scanned: 0', () => {
    expect(() => resolveTimeWindow(undefined, undefined, INCIDENT_END, INCIDENT_START)).toThrow(
      /must be strictly before/
    );
  });

  it('rejects an empty window (equal bounds)', () => {
    expect(() => resolveTimeWindow(undefined, undefined, INCIDENT_START, INCIDENT_START)).toThrow(
      /must be strictly before/
    );
  });

  it('accepts a lower bound alone (open-ended "everything since X" is a real run shape)', () => {
    expect(resolveTimeWindow(undefined, undefined, INCIDENT_START, undefined)).toMatchObject({
      updatedAfterTs: INCIDENT_START,
      updatedBeforeTs: undefined,
    });
  });

  it('does not constrain the add_time axis, where an upper bound alone IS the original cohort', () => {
    expect(() => resolveTimeWindow(CUTOFF, undefined, undefined, undefined)).not.toThrow();
  });

  it('the at-least-one-bound error names all four accepted vars', () => {
    for (const name of [
      'BACKFILL_CUTOFF_TS',
      'BACKFILL_WINDOW_START_TS',
      'BACKFILL_UPDATED_AFTER_TS',
      'BACKFILL_UPDATED_BEFORE_TS',
    ]) {
      expect(() => resolveTimeWindow(undefined, undefined, undefined, undefined)).toThrow(new RegExp(name));
    }
  });
});

describe('resolveDryRun (BS#1998 review)', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['  true  ', true],
    // Repo-wide locked truthy set per docs/env-vars.md — `1` must not abort.
    ['1', true],
    ['false', false],
    ['0', false],
    ['', false],
    [undefined, false],
  ])('parses %p as %p', (raw, expected) => {
    expect(resolveDryRun(raw)).toBe(expected);
  });

  it.each(['yes', 'no', 'on', '2', 'ture'])(
    'throws on %p rather than silently falling back to a live write run',
    (raw) => {
      expect(() => resolveDryRun(raw)).toThrow(/is not a boolean/);
    }
  );
});

describe('resolveMaxConsecutiveSheds (BS#1998 review)', () => {
  it('defaults when unset', () => {
    expect(resolveMaxConsecutiveSheds(undefined)).toBe(MAX_CONSECUTIVE_SHEDS);
  });

  it('accepts 0 as "disabled"', () => {
    expect(resolveMaxConsecutiveSheds('0')).toBe(0);
  });

  it('accepts an explicit threshold', () => {
    expect(resolveMaxConsecutiveSheds('5')).toBe(5);
  });
});

describe('runReenrichment — consecutive-shed abort (BS#1998 review)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // These tests deliberately queue MORE `mockResolvedValueOnce` batches than a
  // working abort consumes — that surplus is what makes a regression show up
  // as a call-count failure instead of an infinite loop. `jest.clearAllMocks()`
  // clears recorded calls but NOT the pending once-queue, so the unconsumed
  // entries would otherwise leak into unrelated later describes and fail them.
  afterEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('aborts the run once LML sheds N consecutive lookups instead of burning the cohort', async () => {
    // Two batches queued, then empty. A working abort never reaches batch 2;
    // a broken one (break leaving only the row loop) would, and the
    // `db.execute` call-count assertion below catches exactly that.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1), makeRow(2), makeRow(3), makeRow(4)])
      .mockResolvedValueOnce([makeRow(5), makeRow(6)])
      .mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('upstream_unavailable_skipped');

    const result = await runReenrichment({
      lookup,
      enrich,
      updatedAfterTs: INCIDENT_START,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
      maxConsecutiveSheds: 3,
    });

    expect(result.failed).toBe(true);
    // The abort must leave the BATCH loop too, not just the row loop.
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    // Stopped ON the third shed — the fourth row is never looked up.
    expect(result.totals.upstream_unavailable_skipped).toBe(3);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('resets the streak on any non-shed outcome — a flapping breaker still lets real work through', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1), makeRow(2), makeRow(3), makeRow(4)])
      .mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest
      .fn<EnrichFn>()
      .mockResolvedValueOnce('upstream_unavailable_skipped')
      .mockResolvedValueOnce('upstream_unavailable_skipped')
      .mockResolvedValueOnce('match')
      .mockResolvedValueOnce('upstream_unavailable_skipped');

    const result = await runReenrichment({
      lookup,
      enrich,
      updatedAfterTs: INCIDENT_START,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
      maxConsecutiveSheds: 3,
    });

    expect(result.failed).toBe(false);
    expect(result.totals.scanned).toBe(4);
    expect(result.totals.upstream_unavailable_skipped).toBe(3);
  });

  it('maxConsecutiveSheds=0 disables the abort', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2), makeRow(3)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('upstream_unavailable_skipped');

    const result = await runReenrichment({
      lookup,
      enrich,
      updatedAfterTs: INCIDENT_START,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
      maxConsecutiveSheds: 0,
    });

    expect(result.failed).toBe(false);
    expect(result.totals.upstream_unavailable_skipped).toBe(3);
  });
});

describe('runReenrichment — upstream_unavailable_skipped counter (BS#1998)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts a shed row separately from still_no_match and leaves it selectable', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest
      .fn<EnrichFn>()
      .mockResolvedValueOnce('upstream_unavailable_skipped')
      .mockResolvedValueOnce('still_no_match');

    const result = await runReenrichment({
      lookup,
      enrich,
      updatedAfterTs: INCIDENT_START,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.totals.upstream_unavailable_skipped).toBe(1);
    expect(result.totals.still_no_match).toBe(1);
    expect(result.totals.scanned).toBe(2);
    // A shed is not a flip — `flipped` tracks real matches only.
    expect(result.flipped).toBe(0);
  });
});

describe('runReenrichment — dry run (BS#1998)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scans the cohort but makes zero LML calls and zero enrich calls', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    const result = await runReenrichment({
      lookup,
      enrich,
      updatedAfterTs: INCIDENT_START,
      updatedBeforeTs: INCIDENT_END,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
      dryRun: true,
    });

    expect(lookup).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    // The scan itself still happens — that count is the deliverable.
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.match).toBe(0);
    expect(result.flipped).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it('defaults to a live run so the existing BS#1433/BS#1823 recipes are unchanged', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    const result = await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, liveActivityLookbackSeconds: 0 });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(result.dryRun).toBe(false);
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

  it('captures exhaustion in failed-step summary instead of propagating (round 4)', async () => {
    // Round 4: runReenrichment catches the exhaustion so its finally arm
    // emits the structured `failed` log line (carrying last_id, the
    // operator's resume cursor). The previous shape — throwing — lost
    // the summary span and the structured totals.
    const err = new Error('sustained outage');
    (db.execute as jest.Mock).mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockRejectedValueOnce(err);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.stopped).toBe(false);
    // Round 6: result.failed=true tells main() to set exitCode=1, so a
    // wrapping script's $? check correctly detects the failed drain.
    expect(result.failed).toBe(true);
    expect(result.totals.scanned).toBe(0);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(3);
  }, 30_000);

  it('result.failed is false on a clean completion', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResult());
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 100,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.failed).toBe(false);
    expect(result.stopped).toBe(false);
  });
});
