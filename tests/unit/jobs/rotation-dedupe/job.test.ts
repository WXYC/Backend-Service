/**
 * Unit tests for the rotation-dedupe one-shot job (#694).
 *
 * Pins the SQL shape and the orchestration around it:
 *   1. The duplicate-group pre-count uses HAVING COUNT(*) > 1 over rows
 *      where (kill_date IS NULL OR kill_date > CURRENT_DATE) so that
 *      historical kills are correctly excluded.
 *   2. The keeper picker is DISTINCT ON (album_id, rotation_bin) ORDER BY
 *      add_date DESC, id ASC — most recent add_date wins, ties broken by
 *      lowest id.
 *   3. The UPDATE stamps kill_date = CURRENT_DATE only on rows whose id is
 *      NOT IN (keepers) AND that share an (album_id, rotation_bin) group
 *      with another active row. Rows from non-duplicate groups are never
 *      touched.
 *   4. The whole pass runs inside db.transaction so a partial failure
 *      doesn't leave the rotation list in a half-deduped state.
 *   5. verifyComplete throws with a remediation hint when groups remain;
 *      passes silently when the count is zero (idempotent).
 *   6. runDedupe short-circuits the UPDATE when the pre-count is zero
 *      (no-op on already-deduped tables).
 */

import { db } from '@wxyc/database';
import {
  applyDedupe,
  countActiveRows,
  formatDuration,
  JOB_NAME,
  runDedupe,
  verifyComplete,
} from '../../../../jobs/rotation-dedupe/job';

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

describe('rotation-dedupe: JOB_NAME', () => {
  it('exposes the canonical job name for log/Sentry tagging', () => {
    expect(JOB_NAME).toBe('rotation-dedupe');
  });
});

describe('rotation-dedupe: applyDedupe SQL shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts duplicate groups via HAVING COUNT(*) > 1 over active rows only', async () => {
    // The pre-count is what gates the UPDATE. It must restrict to active
    // rows (kill_date IS NULL OR kill_date > CURRENT_DATE) so historical
    // kills don't inflate the group count and trigger an unnecessary
    // UPDATE pass on already-deduped data.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ dup_groups: 0 }]);

    await applyDedupe();

    const call = findExecuteCallMatching(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/kill_date"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/kill_date"?\s*>\s*CURRENT_DATE/i);
    expect(sqlText).toMatch(/GROUP\s+BY\s+"?album_id"?\s*,\s*"?rotation_bin"?/i);
  });

  it('skips the UPDATE entirely when the pre-count is zero (no-op idempotency)', async () => {
    // Critical for re-runs against a deduped table: when zero groups have
    // duplicates, the job must not issue a UPDATE that touches every
    // active row (would be wrong AND wasteful).
    (db.execute as jest.Mock).mockResolvedValueOnce([{ dup_groups: 0 }]);

    const result = await applyDedupe();

    expect(result).toEqual({ rowsKilled: 0, groupsCollapsed: 0 });
    // Exactly one execute call (the pre-count). No UPDATE.
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
  });

  it('issues an UPDATE with DISTINCT ON keeper selection when groups exist', async () => {
    // Two regression guards in one test:
    //   - DISTINCT ON (album_id, rotation_bin) is the keeper-picker primitive
    //   - ORDER BY add_date DESC, id ASC encodes "most recent, tie-break by lowest id"
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ dup_groups: 5 }]) // pre-count
      .mockResolvedValueOnce({ count: 13 }); // UPDATE

    await applyDedupe();

    const call = findExecuteCallMatching(/UPDATE[\s\S]*kill_date/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/DISTINCT\s+ON\s*\(\s*"?album_id"?\s*,\s*"?rotation_bin"?\s*\)/i);
    expect(sqlText).toMatch(/ORDER\s+BY[\s\S]*"?add_date"?\s+DESC[\s\S]*"?id"?\s+ASC/i);
  });

  it('UPDATE sets kill_date = CURRENT_DATE on the non-keepers in the duplicate groups', async () => {
    // The kill predicate is "in a duplicate group AND not a keeper AND
    // currently active". Drift here would either kill keepers (data loss)
    // or kill historical rows (rewriting history).
    (db.execute as jest.Mock).mockResolvedValueOnce([{ dup_groups: 5 }]).mockResolvedValueOnce({ count: 13 });

    await applyDedupe();

    const call = findExecuteCallMatching(/UPDATE[\s\S]*kill_date/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/SET\s+"?kill_date"?\s*=\s*CURRENT_DATE/i);
    expect(sqlText).toMatch(/NOT\s+IN\s*\(\s*SELECT\s+"?id"?\s+FROM\s+keepers\s*\)/i);
    // Restrict to active rows only — never re-stamp an already-killed row.
    expect(sqlText).toMatch(/kill_date"?\s+IS\s+NULL[\s\S]*kill_date"?\s*>\s*CURRENT_DATE/i);
  });

  it('returns the postgres-js result.count as the rows-killed number', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ dup_groups: 5 }]).mockResolvedValueOnce({ count: 137 });

    const result = await applyDedupe();

    expect(result.rowsKilled).toBe(137);
    expect(result.groupsCollapsed).toBe(5);
  });

  it('runs the dedupe inside db.transaction', async () => {
    // Without the transaction wrapper, an UPDATE failure mid-flight leaves
    // a half-deduped rotation list — keepers chosen by an intermediate
    // observation and only some non-keepers killed.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ dup_groups: 0 }]);

    await applyDedupe();

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when result.count is missing (defensive null handling)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ dup_groups: 1 }]).mockResolvedValueOnce({}); // no count

    const result = await applyDedupe();

    expect(result.rowsKilled).toBe(0);
    expect(result.groupsCollapsed).toBe(1);
  });
});

describe('rotation-dedupe: applyDedupe excludes orphan album_id IS NULL rows', () => {
  // The rotation table can carry rows with album_id IS NULL (tubafrenzy
  // orphan shape, see #689). Those rows aren't "duplicates of an album" by
  // any meaningful definition — the dedupe must skip them entirely.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('SELECTs / GROUPs / UPDATEs all carry album_id IS NOT NULL', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ dup_groups: 1 }]).mockResolvedValueOnce({ count: 0 });

    await applyDedupe();

    const calls = (db.execute as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    for (const call of calls) {
      const sqlText = renderSql(call[0]);
      expect(sqlText).toMatch(/album_id"?\s+IS\s+NOT\s+NULL/i);
    }
  });
});

describe('rotation-dedupe: verifyComplete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes silently when zero (album_id, rotation_bin) groups remain duplicated', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ remaining: 0 }]);

    await expect(verifyComplete()).resolves.toEqual({ remainingDupGroups: 0 });
  });

  it('throws with a remediation hint when duplicate groups remain', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ remaining: 7 }]);

    await expect(verifyComplete()).rejects.toThrow(/7 \(album_id, rotation_bin\) group/);
    await expect(verifyComplete()).rejects.toThrow(/idempotent/i);
  });
});

describe('rotation-dedupe: countActiveRows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the active row count from the COUNT(*) result', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ active: 482 }]);

    const got = await countActiveRows();

    expect(got).toBe(482);
  });

  it('returns 0 on an empty result (defensive null handling)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    const got = await countActiveRows();

    expect(got).toBe(0);
  });

  it('counts only active rows (kill_date IS NULL OR kill_date > CURRENT_DATE)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ active: 0 }]);

    await countActiveRows();

    const call = findExecuteCallMatching(/SELECT\s+COUNT\(\*\)/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/kill_date"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/kill_date"?\s*>\s*CURRENT_DATE/i);
  });
});

describe('rotation-dedupe: runDedupe acceptance shape', () => {
  /**
   * Acceptance shape: seed three rows for a single (album_id, rotation_bin)
   * group (the Little Brother x9-style scenario from #694, scaled down).
   * After runDedupe, expect 1 keeper + 2 killed. Mocked-DB pattern: we
   * stage the responses in the order applyDedupe -> verifyComplete will
   * issue them, then assert on the resulting summary.
   */
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('seeds 3 active rows in 1 group → kills 2, keeps 1, verifies clean', async () => {
    // Order of execute calls:
    //   1. countActiveRows (started log)            → 3
    //   2. applyDedupe pre-count                     → 1 group
    //   3. applyDedupe UPDATE                         → 2 rows killed
    //   4. verifyComplete COUNT                       → 0 remaining
    //   5. countActiveRows (finished log)             → 1
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ active: 3 }])
      .mockResolvedValueOnce([{ dup_groups: 1 }])
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce([{ remaining: 0 }])
      .mockResolvedValueOnce([{ active: 1 }]);

    const result = await runDedupe();

    expect(result.groupsCollapsed).toBe(1);
    expect(result.rowsKilled).toBe(2);
    expect(result.rowsRemainingActive).toBe(1);
  });

  it('on an already-deduped table runs as a clean no-op (zero rows touched)', async () => {
    // 1. countActiveRows → 482
    // 2. applyDedupe pre-count → 0 (short-circuits the UPDATE)
    // 3. verifyComplete COUNT → 0
    // 4. countActiveRows → 482 (unchanged)
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ active: 482 }])
      .mockResolvedValueOnce([{ dup_groups: 0 }])
      .mockResolvedValueOnce([{ remaining: 0 }])
      .mockResolvedValueOnce([{ active: 482 }]);

    const result = await runDedupe();

    expect(result.groupsCollapsed).toBe(0);
    expect(result.rowsKilled).toBe(0);
    expect(result.rowsRemainingActive).toBe(482);
    // 4 SELECTs, no UPDATE
    expect((db.execute as jest.Mock).mock.calls.length).toBe(4);
  });

  it('propagates a verifyComplete throw (post-dedupe still has duplicate groups)', async () => {
    // The transaction succeeded but the post-pass count says duplicate
    // groups remain. That's the rare case where new INSERTs raced the
    // dedupe — the unique partial index in the companion migration is the
    // durable fix. Surface clearly so ops sees it.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ active: 5 }])
      .mockResolvedValueOnce([{ dup_groups: 1 }])
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce([{ remaining: 1 }]);

    await expect(runDedupe()).rejects.toThrow(/group\(s\) still have/);
  });
});

describe('rotation-dedupe: formatDuration', () => {
  it('formats sub-minute durations as "0m Xs"', () => {
    expect(formatDuration(0)).toBe('0m 0s');
    expect(formatDuration(1500)).toBe('0m 2s');
    expect(formatDuration(45_000)).toBe('0m 45s');
  });

  it('formats multi-minute durations as "Xm Ys"', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
