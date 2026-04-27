/**
 * Unit tests for the B-0.5 broken-FK flowsheet recovery job.
 *
 * The job:
 *   1. Re-runs the legacy_release_id → library.id FK resolver to catch
 *      post-ETL library imports that weren't reconciled at the time.
 *   2. Classifies the residual (missing / collision / other).
 *   3. Stamps legacy_link_attempted_at = now() on the residual so B-2.2's
 *      LML backfill can pick them up alongside the never-had-legacy-id
 *      rows.
 *
 * Tests don't reach the database — they verify that the right shape of
 * SQL is built for each phase, the orchestrator calls phases in order,
 * and the report formatter produces a comment-friendly string.
 */

import { db } from '@wxyc/database';
import {
  reresolveAlbumIds,
  classifyUnresolvable,
  markUnresolvable,
  runRecovery,
  formatReport,
} from '../../../../jobs/broken-fk-recovery/job';

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

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

describe('broken-fk-recovery: reresolveAlbumIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues an UPDATE that joins flowsheet to library on legacy_release_id', async () => {
    // Mirrors the resolver in jobs/flowsheet-etl/job.ts. Re-running it is
    // the easy-win first pass in B-0.5: any library rows that landed after
    // the original ETL get linked here without LML.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await reresolveAlbumIds();

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*album_id[\s\S]*FROM[\s\S]*library/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/legacy_release_id/i);
  });

  it('only touches rows where album_id IS NULL and legacy_release_id IS NOT NULL', async () => {
    // Idempotency guard: re-running must not stomp existing links and must
    // not consider rows with no FK to resolve.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await reresolveAlbumIds();

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/album_id"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/legacy_release_id"?\s+IS\s+NOT\s+NULL/i);
  });

  it('returns the rows-resolved count from postgres-js result.count', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 137 });

    const resolved = await reresolveAlbumIds();

    expect(resolved).toBe(137);
  });
});

describe('broken-fk-recovery: classifyUnresolvable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns counts split by missing / collision / other', async () => {
    // Single round-trip: a CASE/FILTER aggregate beats issuing one COUNT
    // per category against a 1.18M-row table.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ missing: 290000, collision: 0, other: 2226, total: 292226 }]);

    const counts = await classifyUnresolvable();

    expect(counts).toEqual({ missing: 290000, collision: 0, other: 2226, total: 292226 });
  });

  it('coerces row counts to numbers (postgres-js returns bigint as string for COUNT)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ missing: '5', collision: '0', other: '2', total: '7' }]);

    const counts = await classifyUnresolvable();

    expect(counts.missing).toBe(5);
    expect(counts.collision).toBe(0);
    expect(counts.other).toBe(2);
    expect(counts.total).toBe(7);
  });

  it('treats missing as: no library row shares the flowsheet legacy_release_id', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ missing: 0, collision: 0, other: 0, total: 0 }]);

    await classifyUnresolvable();

    const call = findExecuteCallMatching(/missing/i);
    const sqlText = renderSql(call?.[0]);
    // The classification SQL must distinguish missing from collision via
    // a count of matching library rows (0 = missing, >1 = collision).
    expect(sqlText).toMatch(/library/i);
    expect(sqlText).toMatch(/legacy_release_id/i);
  });

  it('returns zeros when the residual is empty (already-recovered state)', async () => {
    // Re-running on a fully-recovered DB must report all zeros, not crash.
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    const counts = await classifyUnresolvable();

    expect(counts).toEqual({ missing: 0, collision: 0, other: 0, total: 0 });
  });
});

describe('broken-fk-recovery: markUnresolvable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stamps legacy_link_attempted_at = now() on the broken-FK residual', async () => {
    // The marker is what B-2.2's LML backfill keys off of to find these
    // rows alongside the never-had-legacy-id rows.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 292226 });

    await markUnresolvable();

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*legacy_link_attempted_at/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/legacy_link_attempted_at"?\s*=\s*now\(\)/i);
  });

  it('only marks rows where album_id IS NULL and legacy_release_id IS NOT NULL', async () => {
    // Don't stamp rows that were just resolved on the re-run, and don't
    // stamp the never-had-legacy-id 889K bucket — those are categorically
    // distinct and B-2.2's predicate already covers them.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await markUnresolvable();

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*legacy_link_attempted_at/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/album_id"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/legacy_release_id"?\s+IS\s+NOT\s+NULL/i);
  });

  it('only stamps rows that have not been stamped before (idempotency)', async () => {
    // Re-running the job after a partial run must skip rows already
    // stamped — otherwise the timestamp would slide forward on every run
    // and lose the "first attempted at" signal.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await markUnresolvable();

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*legacy_link_attempted_at/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/legacy_link_attempted_at"?\s+IS\s+NULL/i);
  });

  it('returns the rows-stamped count from postgres-js result.count', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 292226 });

    const stamped = await markUnresolvable();

    expect(stamped).toBe(292226);
  });
});

describe('broken-fk-recovery: runRecovery orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs phases in order: reresolve → classify → mark', async () => {
    // Order matters: classify must read the post-resolver state (so the
    // "newly recovered" rows aren't reported as broken), and mark must
    // run after classify (so the report reflects the residual that's
    // actually being marked).
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ count: 5 }) // reresolve
      .mockResolvedValueOnce([{ missing: 100, collision: 0, other: 0, total: 100 }]) // classify
      .mockResolvedValueOnce({ count: 100 }); // mark

    const result = await runRecovery();

    expect(result.resolved).toBe(5);
    expect(result.counts).toEqual({ missing: 100, collision: 0, other: 0, total: 100 });
    expect(result.marked).toBe(100);

    const callOrder = (db.execute as jest.Mock).mock.calls.map((c) => renderSql(c[0]));
    expect(callOrder[0]).toMatch(/UPDATE[\s\S]*flowsheet[\s\S]*album_id[\s\S]*FROM[\s\S]*library/i);
    expect(callOrder[1]).toMatch(/missing/i);
    expect(callOrder[2]).toMatch(/UPDATE[\s\S]*flowsheet[\s\S]*legacy_link_attempted_at/i);
  });
});

describe('broken-fk-recovery: formatReport', () => {
  it('renders a comment-friendly breakdown including all three categories', () => {
    // The operator pastes this output as a comment on the issue. Whatever
    // shape future-us picks, the three categories from the issue's
    // acceptance criteria all need to be visible.
    const report = formatReport({ missing: 290000, collision: 0, other: 2226, total: 292226 });
    expect(report).toMatch(/missing[\s\S]*290,?000/i);
    expect(report).toMatch(/collision[\s\S]*0\b/i);
    expect(report).toMatch(/other[\s\S]*2,?226/i);
    expect(report).toMatch(/total[\s\S]*292,?226/i);
  });

  it('handles the all-zeros case (already recovered)', () => {
    const report = formatReport({ missing: 0, collision: 0, other: 0, total: 0 });
    expect(report).toMatch(/0/);
    expect(report).not.toContain('NaN');
    expect(report).not.toContain('undefined');
  });
});
