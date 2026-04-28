/**
 * Unit tests for the flowsheet.dj_name backfill job.
 *
 * The backfill is the runtime counterpart to the DDL-only migration 0053:
 * after the column is added (NULL on every row), this job populates legacy
 * track rows in batched UPDATEs that each commit independently. The 0054
 * migration cannot apply until this backfill is verified complete.
 */

import { db } from '@wxyc/database';
import {
  applyBatch,
  runBackfill,
  verifyComplete,
  formatDuration,
  BATCH_SIZE,
  resolveBatchSize,
} from '../../../../jobs/flowsheet-dj-name-backfill/job';

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

describe('flowsheet-dj-name-backfill: applyBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds an UPDATE that COALESCEs auth_user.dj_name → shows.legacy_dj_name → auth_user.name', async () => {
    // Match the same precedence the search service and live insert path use.
    // Drift here would silently change which name appears for legacy rows.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 5000 });

    await applyBatch(5000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*dj_name[\s\S]*COALESCE/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/COALESCE\(\s*u\."dj_name",\s*s\."legacy_dj_name",\s*u\."name"\s*\)/);
  });

  it('restricts the UPDATE to track rows with NULL dj_name within a bounded batch', async () => {
    // Three regression guards in one test:
    //   - entry_type = 'track' filter (matches 0054's precondition guard)
    //   - dj_name IS NULL (idempotency: re-run skips already-backfilled rows)
    //   - LIMIT in an inner SELECT (bounded batch — never an unbounded UPDATE)
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 5000 });

    await applyBatch(5000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*dj_name/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/entry_type"?\s*=\s*'track'/i);
    expect(sqlText).toMatch(/dj_name"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/LIMIT/i);
  });

  it('passes the batch size argument through into the SQL builder', async () => {
    // Looser assertion than reaching into Drizzle's queryChunks shape (which
    // varies between Drizzle versions). The point of the test is that the
    // function actually uses its argument; serializing the SQL and JSON-
    // stringifying the parameter object catches the value either as a
    // bound parameter or an inlined literal.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await applyBatch(1234);

    const call = (db.execute as jest.Mock).mock.calls.find((c) =>
      /UPDATE[\s\S]*flowsheet[\s\S]*dj_name/i.test(renderSql(c[0]))
    );
    const serialized = JSON.stringify(call?.[0]);
    expect(serialized).toContain('1234');
  });

  it('returns the postgres-js result.count as the rows-updated number', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 4321 });

    const updated = await applyBatch(5000);

    expect(updated).toBe(4321);
  });

  it('returns 0 when the result has no count property (empty result)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({});

    const updated = await applyBatch(5000);

    expect(updated).toBe(0);
  });
});

describe('flowsheet-dj-name-backfill: runBackfill loop control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('iterates batches until applyBatch returns 0 (natural end)', async () => {
    // Three non-empty batches, then one empty batch terminates the loop.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ count: 5000 })
      .mockResolvedValueOnce({ count: 5000 })
      .mockResolvedValueOnce({ count: 1234 })
      .mockResolvedValueOnce({ count: 0 });

    await runBackfill();

    expect((db.execute as jest.Mock).mock.calls.length).toBe(4);
  });

  it('exits cleanly on the very first empty batch (already-backfilled state)', async () => {
    // Re-running on a fully-backfilled DB must be a no-op, not loop forever.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await runBackfill();

    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
  });

  it('defaults BATCH_SIZE to 5000 when BACKFILL_BATCH_SIZE is unset', () => {
    // The whole point of the rewrite is bounded UPDATEs. The default is
    // chosen so a single batch finishes well under the per-statement
    // timeout even on a hot table; operators can opt into a larger value
    // via env when the prod instance has headroom.
    expect(BATCH_SIZE).toBe(5000);
  });
});

describe('flowsheet-dj-name-backfill: resolveBatchSize', () => {
  it('returns 5000 by default when the env var is unset', () => {
    expect(resolveBatchSize(undefined)).toBe(5000);
  });

  it('parses a custom positive integer', () => {
    // Operators set this to e.g. 20000 once the prod instance has gp3
    // capacity and async commit is in play — fewer commits + fewer trigger
    // dispatches per batch amortizes per-tx overhead.
    expect(resolveBatchSize('20000')).toBe(20000);
  });

  it('rejects zero (a no-op infinite loop)', () => {
    expect(() => resolveBatchSize('0')).toThrow(/BACKFILL_BATCH_SIZE=.*positive integer/);
  });

  it('rejects negative values', () => {
    expect(() => resolveBatchSize('-1')).toThrow(/BACKFILL_BATCH_SIZE=.*positive integer/);
  });

  it('rejects non-numeric values', () => {
    expect(() => resolveBatchSize('twenty-thousand')).toThrow(/BACKFILL_BATCH_SIZE=.*positive integer/);
  });

  it('rejects fractional values (the planner LIMIT must be integral)', () => {
    expect(() => resolveBatchSize('5000.5')).toThrow(/BACKFILL_BATCH_SIZE=.*positive integer/);
  });
});

describe('flowsheet-dj-name-backfill: verifyComplete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes when zero track rows have NULL dj_name', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ missing: 0 }]);

    await expect(verifyComplete()).resolves.toBeUndefined();
  });

  it('throws with a remediation hint when track rows still have NULL dj_name', async () => {
    // mockResolvedValue (not Once) so both rejection assertions get the
    // same response — the second await re-invokes verifyComplete.
    (db.execute as jest.Mock).mockResolvedValue([{ missing: 137 }]);

    await expect(verifyComplete()).rejects.toThrow(/137 track row\(s\)/);
    await expect(verifyComplete()).rejects.toThrow(/idempotent/i);
  });
});

describe('flowsheet-dj-name-backfill: formatDuration', () => {
  it('formats sub-minute durations as "0m Xs"', () => {
    expect(formatDuration(0)).toBe('0m 0s');
    expect(formatDuration(1500)).toBe('0m 2s');
    expect(formatDuration(45_000)).toBe('0m 45s');
  });

  it('formats multi-minute durations as "Xm Ys"', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_600_000)).toBe('60m 0s');
  });
});
