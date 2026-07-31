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
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  runSweep,
  resolveDryRun,
  resolveAfterId,
  type DeleteBatchFn,
  type AnalyzeFn,
  __resetStopForTesting,
} from '../../../../jobs/flowsheet-ghost-row-sweep/orchestrate';
import type { LegacyKeyspaceSource } from '../../../../jobs/flowsheet-ghost-row-sweep/keyspace-source';

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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // rotation: no candidates

    const deleteBatch = jest.fn<DeleteBatchFn>().mockResolvedValue(2);
    const analyzeTable = jest.fn<AnalyzeFn>().mockResolvedValue(undefined);

    const result = await runSweep({
      dryRun: false,
      keyspaceSource: keyspaceSource([100], []), // 200 and 300 are ghosts
      deleteBatch,
      analyzeTable,
      liveActivityLookbackSeconds: 0,
    });

    expect(result.failed).toBe(false);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    expect(deleteBatch).toHaveBeenCalledWith('flowsheet', [2, 3], expect.any(Number));
    expect(result.flowsheet.removed).toBe(2);
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
      dryRun: true,
      keyspaceSource: keyspaceSource([1, 2, 3], []), // nothing is a ghost
      deleteBatch,
      analyzeTable,
      liveActivityLookbackSeconds: 0,
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
    });

    expect(result.failed).toBe(true);
    // Cursor stays at the caller-supplied afterId (0) — the failing page's
    // max id (2) never lands in last_id, so a re-run re-selects it.
    expect(result.flowsheet.last_id).toBe(0);
    expect(analyzeTable).not.toHaveBeenCalled();
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
