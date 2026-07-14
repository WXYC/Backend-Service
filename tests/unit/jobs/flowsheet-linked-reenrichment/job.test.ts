/**
 * Unit tests for the flowsheet-linked-reenrichment job — Lane A (BS#1638).
 *
 * Covers the Lane A acceptance criteria: the frozen cohort predicate on every
 * SELECT/UPDATE, the flip semantics (batched, SET enriched_match literal, no
 * metadata_attempt_at write, never 'pending'), the cooperative pause, and
 * dry-run. Lane B's residual enumeration / LML re-lookup / fill-null UPSERT
 * tests land with Lane B in the chained follow-up PR.
 *
 * SQL is asserted via text inspection (same pattern as the donor
 * tests/unit/jobs/album-level-backfill/job.test.ts).
 */

import { jest } from '@jest/globals';

jest.mock('@sentry/node', () => ({
  __esModule: true,
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  init: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import { db, checkLiveActivity } from '@wxyc/database';
import {
  COHORT_ADD_TIME_CUTOFF,
  countPopulatedFlipCandidates,
  flipBatch,
  flipPopulatedCohort,
  analyzeFlowsheet,
  awaitQuietWindow,
  resolveDryRun,
  resolveOptions,
  runReenrichment,
  FLIP_BATCH_SIZE_DEFAULT,
  FLIP_BATCH_SIZE_ENV,
  FLIP_TIMEOUT_DEFAULT,
  READ_TIMEOUT_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_ENV,
  type ReenrichmentOptions,
} from '../../../../jobs/flowsheet-linked-reenrichment/job';

// The unit drizzle-orm mock (tests/__mocks__/drizzle-orm.ts) shapes the `sql`
// tag as `{ sql: TemplateStringsArray, values }`. Interpolated values —
// including nested `sql` fragments like our shared `cohortPredicate` — live
// in `values`, NOT interleaved in `sql`. Interleave them and recurse so the
// composed WHERE renders. Bound scalars (numbers) render empty; assertions
// key off the literal SQL text, not param values.
const renderSql = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const obj = value as { raw?: string; sql?: string | string[]; values?: unknown[] };
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) {
    const strings = obj.sql;
    const values = obj.values ?? [];
    let out = '';
    for (let i = 0; i < strings.length; i += 1) {
      out += strings[i];
      if (i < values.length) out += renderSql(values[i]);
    }
    return out;
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined =>
  (db.execute as jest.Mock).mock.calls.find((call) => pattern.test(renderSql(call[0])));

const RESET_ENV_KEYS = [FLIP_BATCH_SIZE_ENV, LIVE_ACTIVITY_LOOKBACK_ENV];
const stripEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out = { ...env };
  for (const k of RESET_ENV_KEYS) delete out[k];
  return out;
};

beforeEach(() => {
  jest.clearAllMocks();
  (checkLiveActivity as jest.Mock).mockResolvedValue(false);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Frozen cohort predicate — every SELECT/UPDATE must carry all four clauses.
// ---------------------------------------------------------------------------

const expectCohortPredicate = (text: string): void => {
  expect(text).toMatch(/"?metadata_status"?\s*=\s*'enriched_no_match'/i);
  expect(text).toMatch(/"?album_id"?\s+IS\s+NOT\s+NULL/i);
  expect(text).toMatch(/"?artist_name"?\s+IS\s+NOT\s+NULL/i);
  expect(text).toMatch(/"?add_time"?\s*<\s*\$?\d*.*timestamptz/i);
  // No entry_type narrow — the frozen predicate is exactly four clauses.
  expect(text).not.toMatch(/entry_type/i);
};

describe('COHORT_ADD_TIME_CUTOFF', () => {
  it('is the frozen BS#1443 cutoff', () => {
    expect(COHORT_ADD_TIME_CUTOFF).toBe('2026-06-16T17:53:53Z');
  });
});

describe('countPopulatedFlipCandidates', () => {
  it('COUNTs cohort rows joined to populated album_metadata inside a timeout tx', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ count: 15231 }]);

    const n = await countPopulatedFlipCandidates();

    expect(n).toBe(15231);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    const call = findExecuteCallMatching(/count\(\*\)/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expectCohortPredicate(text);
    expect(text).toMatch(/JOIN\s+"?wxyc_schema"?\."?album_metadata"?/i);
    expect(text).toMatch(/am\."?discogs_url"?\s+IS\s+NOT\s+NULL\s+OR\s+am\."?artwork_url"?\s+IS\s+NOT\s+NULL/i);
    const setLocal = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(setLocal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lane A flip.
// ---------------------------------------------------------------------------

describe('flipBatch', () => {
  it('UPDATEs flowsheet via JOIN to populated album_metadata, SET enriched_match, no metadata_attempt_at, batched', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const n = await flipBatch(5000, 60_000);

    expect(n).toBe(2);
    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expectCohortPredicate(text);
    expect(text).toMatch(/SET\s+"?metadata_status"?\s*=\s*'enriched_match'/i);
    expect(text).toMatch(/am\."?discogs_url"?\s+IS\s+NOT\s+NULL\s+OR\s+am\."?artwork_url"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/LIMIT/i);
    expect(text).toMatch(/ORDER\s+BY\s+f\."?id"?/i);
    // BS#1011/BS#895 invariant: the flip must not touch metadata_attempt_at.
    expect(text).not.toMatch(/metadata_attempt_at/i);
    // BS#1443 invariant: must not re-arm the cron by setting 'pending'.
    expect(text).not.toMatch(/'pending'/i);
  });

  it('runs inside a transaction with the parameterized statement timeout', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await flipBatch(5000, 123_456);
    const setLocal = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(renderSql(setLocal?.[0])).toMatch(/123456ms/);
  });
});

describe('flipPopulatedCohort', () => {
  it('loops flipBatch until a batch flips 0 rows and returns the total', async () => {
    const exec = db.execute as jest.Mock;
    // batch 1: SET LOCAL, UPDATE→3 rows; batch 2: SET LOCAL, UPDATE→0 rows.
    exec
      .mockResolvedValueOnce([]) // SET LOCAL
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]) // UPDATE
      .mockResolvedValueOnce([]) // SET LOCAL
      .mockResolvedValueOnce([]); // UPDATE → 0

    const total = await flipPopulatedCohort('lane_a', 5000, 60_000, 0, 1);

    expect(total).toBe(3);
    // Two flipBatch iterations = two transactions.
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(2);
  });

  it('checks the cooperative pause before each batch', async () => {
    const exec = db.execute as jest.Mock;
    exec.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // one empty batch
    await flipPopulatedCohort('lane_a', 5000, 60_000, 60, 1);
    // awaitQuietWindow → checkLiveActivity called at least once before the batch.
    expect((checkLiveActivity as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// ANALYZE.
// ---------------------------------------------------------------------------

describe('ANALYZE', () => {
  it('analyzeFlowsheet issues ANALYZE flowsheet', async () => {
    await analyzeFlowsheet();
    expect(renderSql(findExecuteCallMatching(/ANALYZE/i)?.[0])).toMatch(/flowsheet/i);
  });
});

// ---------------------------------------------------------------------------
// awaitQuietWindow.
// ---------------------------------------------------------------------------

describe('awaitQuietWindow', () => {
  it('returns immediately when no activity', async () => {
    (checkLiveActivity as jest.Mock).mockResolvedValue(false);
    await awaitQuietWindow(60, 1);
    expect((checkLiveActivity as jest.Mock).mock.calls.length).toBe(1);
  });
  it('loops until the probe returns false', async () => {
    (checkLiveActivity as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await awaitQuietWindow(60, 1);
    expect((checkLiveActivity as jest.Mock).mock.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Flag + env resolution.
// ---------------------------------------------------------------------------

describe('resolveDryRun', () => {
  it('defaults to dry-run (true) when neither flag is passed', () => {
    expect(resolveDryRun([])).toBe(true);
  });
  it('is false only with --execute', () => {
    expect(resolveDryRun(['node', 'job.js', '--execute'])).toBe(false);
  });
  it('accepts --dry-run as an explicit no-op', () => {
    expect(resolveDryRun(['node', 'job.js', '--dry-run'])).toBe(true);
  });
  it('throws on contradictory flags', () => {
    expect(() => resolveDryRun(['--execute', '--dry-run'])).toThrow(/Contradictory/);
  });
});

describe('resolveOptions', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses defaults when env is unset', () => {
    const opts = resolveOptions(stripEnv(process.env), []);
    expect(opts.flipBatchSize).toBe(FLIP_BATCH_SIZE_DEFAULT);
    expect(opts.flipTimeoutMs).toBe(FLIP_TIMEOUT_DEFAULT);
    expect(opts.readTimeoutMs).toBe(READ_TIMEOUT_DEFAULT);
    expect(opts.liveActivityLookbackSeconds).toBe(LIVE_ACTIVITY_LOOKBACK_DEFAULT);
    expect(opts.dryRun).toBe(true);
  });

  it('honors env overrides and --execute', () => {
    const env = { ...stripEnv(process.env), [FLIP_BATCH_SIZE_ENV]: '2000' };
    const opts = resolveOptions(env, ['--execute']);
    expect(opts.flipBatchSize).toBe(2000);
    expect(opts.dryRun).toBe(false);
  });

  it('allows LIVE_ACTIVITY_LOOKBACK_SECONDS=0 (catch-up)', () => {
    expect(
      resolveOptions({ ...stripEnv(process.env), [LIVE_ACTIVITY_LOOKBACK_ENV]: '0' }, []).liveActivityLookbackSeconds
    ).toBe(0);
  });

  it('throws on invalid env', () => {
    expect(() => resolveOptions({ ...stripEnv(process.env), [FLIP_BATCH_SIZE_ENV]: '0' }, [])).toThrow(
      /positive integer/
    );
    expect(() => resolveOptions({ ...stripEnv(process.env), [FLIP_BATCH_SIZE_ENV]: '-1' }, [])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Top-level orchestration (Lane A).
// ---------------------------------------------------------------------------

const baseOptions = (over: Partial<ReenrichmentOptions> = {}): ReenrichmentOptions => ({
  flipBatchSize: 5000,
  flipTimeoutMs: 60_000,
  readTimeoutMs: 300_000,
  liveActivityLookbackSeconds: 0,
  liveActivityPauseMs: 1,
  dryRun: false,
  ...over,
});

describe('runReenrichment', () => {
  it('dry-run: scope count only, no flip, no ANALYZE', async () => {
    const exec = db.execute as jest.Mock;
    exec
      .mockResolvedValueOnce([]) // SET LOCAL (count)
      .mockResolvedValueOnce([{ count: 15231 }]); // count

    const summary = await runReenrichment(baseOptions({ dryRun: true }));

    expect(summary.lane_a_candidates).toBe(15231);
    expect(summary.flipped_from_album_metadata).toBe(0);
    // No UPDATE...flowsheet (no flip) and no ANALYZE in dry-run.
    expect(findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i)).toBeUndefined();
    expect(findExecuteCallMatching(/ANALYZE/i)).toBeUndefined();
  });

  it('execute: flips the populated cohort and ANALYZEs after', async () => {
    const exec = db.execute as jest.Mock;
    exec
      .mockResolvedValueOnce([]) // SET LOCAL (count)
      .mockResolvedValueOnce([{ count: 2 }]) // count
      .mockResolvedValueOnce([]) // SET LOCAL (flip batch 1)
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }]) // UPDATE → 2
      .mockResolvedValueOnce([]) // SET LOCAL (flip batch 2)
      .mockResolvedValueOnce([]) // UPDATE → 0
      .mockResolvedValueOnce([]); // ANALYZE flowsheet

    const summary = await runReenrichment(baseOptions());

    expect(summary.lane_a_candidates).toBe(2);
    expect(summary.lane_a_flipped).toBe(2);
    expect(summary.flipped_from_album_metadata).toBe(2);
    expect(findExecuteCallMatching(/ANALYZE\s+"?wxyc_schema"?\."?flowsheet"?/i)).toBeDefined();
  });

  it('execute: 0 candidates → 0 flipped, no ANALYZE', async () => {
    const exec = db.execute as jest.Mock;
    exec
      .mockResolvedValueOnce([]) // SET LOCAL (count)
      .mockResolvedValueOnce([{ count: 0 }]) // count
      .mockResolvedValueOnce([]) // SET LOCAL (flip batch 1)
      .mockResolvedValueOnce([]); // UPDATE → 0

    const summary = await runReenrichment(baseOptions());

    expect(summary.lane_a_flipped).toBe(0);
    expect(summary.flipped_from_album_metadata).toBe(0);
    // lane_a_flipped=0 → ANALYZE skipped.
    expect(findExecuteCallMatching(/ANALYZE/i)).toBeUndefined();
  });
});
