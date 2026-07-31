/**
 * Unit tests for flowsheet-ghost-row-sweep orchestrate.ts.
 *
 * Pins the behaviors the sweep depends on:
 *   1. resolveDryRun: dry-run is the default; --execute opts in; both flags
 *      is a contradiction.
 *   2. The in-process anti-join: a row's legacy id absent from the loaded
 *      keyspace Set is a ghost; present is not — regardless of what SQL
 *      predicate loaded the candidate page.
 *   3. The id-cursor advances across batches per target and the loop
 *      terminates when a batch returns empty.
 *   4. Dry-run computes ghosts/sample but never calls the injected
 *      deleteBatch; --execute calls it with exactly the ghost ids for that
 *      page and calls analyzeTable once per target that actually wrote.
 *   5. A failed deleteBatch call does not advance the resume cursor past
 *      the failing page and marks the run failed.
 *   6. A keyspace-source load failure ends the run before either target's
 *      loadBatch is ever called.
 *   7. A keyspace smaller than the configured floor refuses the whole run
 *      before either target loads a batch — even if only one target's
 *      keyspace is undersized.
 *   8. Post-run verification (execute + clean finish only): a target that
 *      still shows a ghost on re-scan fails the run and records
 *      `remaining`; a clean re-scan records `remaining: 0` and leaves the
 *      run unfailed.
 *
 * Tests below that intentionally pass an empty keyspace Set to exercise
 * behaviors unrelated to the empty-keyspace floor pass `minKeyspaceSize: 0`
 * to disable it — see describe block 7 for the floor's own coverage.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  runSweep,
  resolveDryRun,
  resolveAfterId,
  resolveMaxGhostRatio,
  deleteBatch,
  analyzeTable,
  requestStop,
  MAX_GHOST_RATIO_DEFAULT,
  type DeleteBatchFn,
  type AnalyzeFn,
  __resetStopForTesting,
} from '../../../../jobs/flowsheet-ghost-row-sweep/orchestrate';
import type { LegacyKeyspaceSource } from '../../../../jobs/flowsheet-ghost-row-sweep/keyspace-source';

/**
 * Render the tests/__mocks__/drizzle-orm.ts sql-tag shape ({ sql: strings,
 * values }) to a flat string, recursing into nested fragments, sql.raw
 * identifiers, and sql.join lists — lets the deleteBatch / analyzeTable
 * write-path tests assert the composed SQL (mirrors the streaming-url-remediation
 * suite's helper).
 */
type SqlLike = { sql?: string | string[]; values?: unknown[]; raw?: string; join?: unknown[]; sep?: unknown };
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.join)) return obj.join.map(renderSql).join(renderSql(obj.sep));
  if (Array.isArray(obj.sql)) {
    const values = obj.values ?? [];
    return obj.sql.map((chunk, i) => chunk + (i < values.length ? renderSql(values[i]) : '')).join('');
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};
const renderedExecuteCalls = (): string[] => (db.execute as jest.Mock).mock.calls.map((c) => renderSql(c?.[0]));

const makeRow = (id: number, legacyId: number) => ({ id, legacy_id: legacyId });

const keyspaceSource = (flowsheetIds: number[], rotationIds: number[]): LegacyKeyspaceSource => ({
  loadFlowsheetIds: jest.fn<() => Promise<Set<number>>>().mockResolvedValue(new Set(flowsheetIds)),
  loadRotationIds: jest.fn<() => Promise<Set<number>>>().mockResolvedValue(new Set(rotationIds)),
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetStopForTesting();
});

describe('resolveDryRun', () => {
  it('defaults to dry-run when no flags are passed', () => {
    expect(resolveDryRun([])).toBe(true);
  });

  it('--execute opts into writes', () => {
    expect(resolveDryRun(['--execute'])).toBe(false);
  });

  it('--dry-run is an explicit no-op', () => {
    expect(resolveDryRun(['--dry-run'])).toBe(true);
  });

  it('throws when both flags are passed', () => {
    expect(() => resolveDryRun(['--execute', '--dry-run'])).toThrow(/Contradictory flags/);
  });
});

describe('resolveAfterId', () => {
  it('falls back to 0 when unset', () => {
    expect(resolveAfterId('GHOST_SWEEP_FLOWSHEET_AFTER_ID', undefined)).toBe(0);
  });

  it('returns the parsed non-negative integer', () => {
    expect(resolveAfterId('GHOST_SWEEP_FLOWSHEET_AFTER_ID', '42')).toBe(42);
  });

  it('throws on a negative value', () => {
    expect(() => resolveAfterId('GHOST_SWEEP_FLOWSHEET_AFTER_ID', '-1')).toThrow(/GHOST_SWEEP_FLOWSHEET_AFTER_ID/);
  });
});

describe('runSweep — dry-run', () => {
  it('flags ghosts and samples their ids without calling deleteBatch', async () => {
    (db.execute as jest.Mock)
      // flowsheet: one page of two rows, then empty
      .mockResolvedValueOnce([makeRow(1, 100), makeRow(2, 200)])
      .mockResolvedValueOnce([])
      // rotation: empty immediately
      .mockResolvedValueOnce([]);

    const deleteBatch = jest.fn<DeleteBatchFn>().mockResolvedValue(0);
    const analyzeTable = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: true,
      keyspaceSource: keyspaceSource([100], []), // legacy_id 200 is a ghost, 100 still exists upstream
      deleteBatch,
      analyzeTable,
      liveActivityLookbackSeconds: 0,
      minKeyspaceSize: 0, // rotation's keyspace is deliberately empty here; unrelated to the floor test below
    });

    expect(result.failed).toBe(false);
    expect(result.flowsheet.scanned).toBe(2);
    expect(result.flowsheet.ghosts).toBe(1);
    expect(result.flowsheet.sample).toEqual([2]);
    expect(result.flowsheet.removed).toBe(0);
    expect(result.rotation.scanned).toBe(0);
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(analyzeTable).not.toHaveBeenCalled();
  });
});

describe('runSweep — execute', () => {
  it('deletes exactly the ghost ids per page and ANALYZEs a target that wrote', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1, 100), makeRow(2, 200), makeRow(3, 300)])
      .mockResolvedValueOnce([]) // flowsheet main loop exhausted
      .mockResolvedValueOnce([]) // flowsheet post-run verification re-scan: clean (flowsheet wrote)
      .mockResolvedValueOnce([]); // rotation: no candidates (wrote nothing → no verification re-scan)

    const deleteBatch = jest.fn<DeleteBatchFn>().mockResolvedValue(2);
    const analyzeTable = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: false,
      keyspaceSource: keyspaceSource([100], []), // 200 and 300 are ghosts
      deleteBatch,
      analyzeTable,
      liveActivityLookbackSeconds: 0,
      minKeyspaceSize: 0, // rotation's keyspace is deliberately empty here; unrelated to the floor test below
    });

    expect(result.failed).toBe(false);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    expect(deleteBatch).toHaveBeenCalledWith('flowsheet', [2, 3], expect.any(Number));
    expect(result.flowsheet.removed).toBe(2);
    expect(result.flowsheet.remaining).toBe(0);
    // rotation deleted nothing (wrote === false), so its post-run verification
    // re-scan is skipped and `remaining` stays at its unverified -1 default.
    expect(result.rotation.remaining).toBe(-1);
    expect(analyzeTable).toHaveBeenCalledTimes(1);
    expect(analyzeTable).toHaveBeenCalledWith('flowsheet', expect.any(Number));
  });

  it('advances the id-cursor across multiple pages and stops on an empty page', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(10, 1), makeRow(20, 2)])
      .mockResolvedValueOnce([makeRow(30, 3)])
      .mockResolvedValueOnce([]) // flowsheet exhausted
      .mockResolvedValueOnce([]); // rotation: no candidates

    const deleteBatch = jest.fn<DeleteBatchFn>().mockResolvedValue(0);
    const analyzeTable = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: true, // dry-run: no post-run verification, so the db.execute count below stays exactly 4
      keyspaceSource: keyspaceSource([1, 2, 3], []), // nothing is a ghost
      deleteBatch,
      analyzeTable,
      liveActivityLookbackSeconds: 0,
      minKeyspaceSize: 0, // rotation's keyspace is deliberately empty here; unrelated to the floor test below
    });

    expect(result.flowsheet.scanned).toBe(3);
    expect(result.flowsheet.batches).toBe(2);
    expect(result.flowsheet.last_id).toBe(30);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(4);
  });

  it('a failed DELETE does not advance the resume cursor and marks the run failed', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1, 100), makeRow(2, 200)]);

    const deleteBatch = jest.fn<DeleteBatchFn>().mockRejectedValue(new Error('statement timeout'));
    const analyzeTable = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: false,
      keyspaceSource: keyspaceSource([], []), // both rows are ghosts
      deleteBatch,
      analyzeTable,
      liveActivityLookbackSeconds: 0,
      minKeyspaceSize: 0, // both keyspaces are deliberately empty here; unrelated to the floor test below
    });

    expect(result.failed).toBe(true);
    // Cursor stays at the caller-supplied afterId (0) — the failing page's
    // max id (2) never lands in last_id, so a re-run re-selects it.
    expect(result.flowsheet.last_id).toBe(0);
    expect(analyzeTable).not.toHaveBeenCalled();
    // The delete failure short-circuits before post-run verification runs.
    expect(result.flowsheet.remaining).toBe(-1);
  });

  it('post-run verification fails the run when a ghost is still present after DELETE (async-commit rollback)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1, 100), makeRow(2, 200)]) // flowsheet main loop: id 2 is a ghost
      .mockResolvedValueOnce([]) // flowsheet main loop exhausted
      // Verification re-scan from afterId=0: the DELETE call reported
      // success, but row 2 is still here — simulates a page that appeared
      // to commit and was then lost to a crash under async commit.
      .mockResolvedValueOnce([makeRow(2, 200)])
      .mockResolvedValueOnce([]); // verification re-scan exhausted

    const deleteBatch = jest.fn<DeleteBatchFn>().mockResolvedValue(1);
    const analyzeTable = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: false,
      keyspaceSource: keyspaceSource([100], [1]), // rotation kept non-empty so it isn't the thing under test
      deleteBatch,
      analyzeTable,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.failed).toBe(true);
    expect(result.flowsheet.remaining).toBe(1);
    // The main loop's own bookkeeping still reports the delete as applied —
    // verification is what catches the discrepancy, not the loop itself.
    expect(result.flowsheet.removed).toBe(1);
  });
});

describe('runSweep — empty/undersized keyspace floor', () => {
  it('refuses the run when either target keyspace is below the default floor, before any batch loads', async () => {
    const result = await runSweep({
      dryRun: true,
      keyspaceSource: keyspaceSource([], [1, 2, 3]), // flowsheet keyspace is empty; rotation is fine
      liveActivityLookbackSeconds: 0,
    });

    expect(result.failed).toBe(true);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a fully empty keyspace on both targets also refuses (the common "file missing" shape)', async () => {
    const result = await runSweep({
      dryRun: true,
      keyspaceSource: keyspaceSource([], []),
      liveActivityLookbackSeconds: 0,
    });

    expect(result.failed).toBe(true);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('minKeyspaceSize: 0 disables the floor for a deliberate empty-fixture run', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]); // every target/verification call: empty

    const result = await runSweep({
      dryRun: true,
      keyspaceSource: keyspaceSource([], []),
      minKeyspaceSize: 0,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.failed).toBe(false);
  });
});

describe('runSweep — keyspace load failure', () => {
  it('ends the run before either target loads a batch', async () => {
    const failingSource: LegacyKeyspaceSource = {
      loadFlowsheetIds: jest.fn<() => Promise<Set<number>>>().mockRejectedValue(new Error('ENOENT')),
      loadRotationIds: jest.fn<() => Promise<Set<number>>>().mockResolvedValue(new Set()),
    };

    const result = await runSweep({
      dryRun: true,
      keyspaceSource: failingSource,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.failed).toBe(true);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe('resolveMaxGhostRatio', () => {
  it('defaults to MAX_GHOST_RATIO_DEFAULT when unset or blank', () => {
    expect(resolveMaxGhostRatio(undefined)).toBe(MAX_GHOST_RATIO_DEFAULT);
    expect(resolveMaxGhostRatio('  ')).toBe(MAX_GHOST_RATIO_DEFAULT);
  });

  it('parses a fraction in (0, 1]', () => {
    expect(resolveMaxGhostRatio('0.25')).toBe(0.25);
    expect(resolveMaxGhostRatio('1')).toBe(1); // 1 = disabled (ratio can never exceed 1)
  });

  it('rejects a non-positive, out-of-range, or non-numeric value', () => {
    expect(() => resolveMaxGhostRatio('0')).toThrow(/GHOST_SWEEP_MAX_GHOST_RATIO/);
    expect(() => resolveMaxGhostRatio('-0.5')).toThrow(/GHOST_SWEEP_MAX_GHOST_RATIO/);
    expect(() => resolveMaxGhostRatio('1.5')).toThrow(/GHOST_SWEEP_MAX_GHOST_RATIO/);
    expect(() => resolveMaxGhostRatio('abc')).toThrow(/GHOST_SWEEP_MAX_GHOST_RATIO/);
  });
});

describe('runSweep — ghost-fraction ceiling', () => {
  it('aborts a target (before its DELETE) once the running ghost fraction exceeds the ceiling', async () => {
    // A truncated keyspace: the file has a few surviving ids, so the empty
    // floor (size >= 1) passes, but nearly every scanned row anti-joins as a
    // ghost. The ratio guard is what catches this. One full page of two
    // all-ghost rows (batchSize 2) arms the guard at scanned === batchSize.
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1, 10), makeRow(2, 20)]);

    const deleteBatchFn = jest.fn<DeleteBatchFn>().mockResolvedValue(2);
    const analyzeFn = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: false, // prove the guard trips BEFORE any DELETE
      keyspaceSource: keyspaceSource([999], [999]), // neither scanned legacy id (10/20) is present → all ghosts
      deleteBatch: deleteBatchFn,
      analyzeTable: analyzeFn,
      liveActivityLookbackSeconds: 0,
      minKeyspaceSize: 0, // isolate the ratio guard from the empty floor
      maxGhostRatio: 0.5,
      batchSize: 2,
    });

    expect(result.failed).toBe(true);
    expect(result.flowsheet.scanned).toBe(2);
    expect(result.flowsheet.ghosts).toBe(2);
    expect(result.flowsheet.removed).toBe(0);
    expect(deleteBatchFn).not.toHaveBeenCalled(); // aborted before the page's DELETE
  });

  it('does not arm before a full page has been scanned', async () => {
    // Only one row scanned with batchSize 2 — below the arming threshold — so
    // even a 100%-ghost partial page runs to (an empty next page) without the
    // guard firing.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1, 10)]) // 1 row < batchSize 2 → guard not armed
      .mockResolvedValueOnce([]) // flowsheet exhausted
      .mockResolvedValueOnce([]); // rotation: no candidates

    const result = await runSweep({
      dryRun: true,
      keyspaceSource: keyspaceSource([], []),
      liveActivityLookbackSeconds: 0,
      minKeyspaceSize: 0,
      maxGhostRatio: 0.5,
      batchSize: 2,
    });

    expect(result.failed).toBe(false);
    expect(result.flowsheet.ghosts).toBe(1);
  });

  it('maxGhostRatio: 1 disables the guard even on an all-ghost sweep', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1, 10), makeRow(2, 20)])
      .mockResolvedValueOnce([]) // flowsheet exhausted
      .mockResolvedValueOnce([]); // rotation: no candidates

    const result = await runSweep({
      dryRun: true,
      keyspaceSource: keyspaceSource([], []),
      liveActivityLookbackSeconds: 0,
      minKeyspaceSize: 0,
      maxGhostRatio: 1,
      batchSize: 2,
    });

    expect(result.failed).toBe(false);
    expect(result.flowsheet.ghosts).toBe(2);
  });
});

describe('runSweep — SIGTERM during post-run verification', () => {
  it('classifies a verification-scan throw seen after stopRequested as a graceful stop, not a failure', async () => {
    // flowsheet deletes a ghost (wrote === true → verification runs). The
    // verification re-scan's loadBatch then flips the stop flag and rejects,
    // simulating a SIGTERM arriving mid-scan (loadBatch rethrows immediately
    // once it sees stopRequested). The run must end `stopped`, not `failed`.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1, 200)]) // flowsheet main loop: id 1 is a ghost
      .mockResolvedValueOnce([]) // flowsheet main loop exhausted
      .mockImplementationOnce(() => {
        requestStop();
        return Promise.reject(new Error('connection terminated'));
      }); // flowsheet verification re-scan: SIGTERM lands, loadBatch throws

    const deleteBatchFn = jest.fn<DeleteBatchFn>().mockResolvedValue(1);
    const analyzeFn = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: false,
      keyspaceSource: keyspaceSource([100], [1]),
      deleteBatch: deleteBatchFn,
      analyzeTable: analyzeFn,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.stopped).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.flowsheet.remaining).toBe(-1); // never got a completed count
  });
});

describe('deleteBatch (real write path)', () => {
  it('wraps the DELETE in a raised-timeout transaction and returns the affected count', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 2 });

    const removed = await deleteBatch('flowsheet', [2, 3], 300000);

    expect(removed).toBe(2);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const calls = renderedExecuteCalls();
    expect(calls.some((s) => /SET LOCAL statement_timeout\s*=\s*300000/.test(s))).toBe(true);
    expect(calls.some((s) => /DELETE FROM.*"flowsheet".*= ANY\(\{2,3\}::int\[\]\)/s.test(s))).toBe(true);
  });

  it('short-circuits an empty id list without opening a transaction', async () => {
    const removed = await deleteBatch('rotation', [], 300000);

    expect(removed).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('falls back to the id count when the driver result omits a count', async () => {
    (db.execute as jest.Mock).mockResolvedValue({}); // no .count on the result

    const removed = await deleteBatch('flowsheet', [7, 8, 9], 300000);

    expect(removed).toBe(3);
  });
});

describe('analyzeTable (real write path)', () => {
  it('runs ANALYZE on the target table in a raised-timeout transaction', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await analyzeTable('rotation', 300000);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const calls = renderedExecuteCalls();
    expect(calls.some((s) => /SET LOCAL statement_timeout\s*=\s*300000/.test(s))).toBe(true);
    expect(calls.some((s) => /ANALYZE\s+"[^"]*"\."rotation"/.test(s))).toBe(true);
  });
});
