/**
 * Unit tests for the library.artist_name backfill job (Epic A.2).
 *
 * The backfill is the runtime counterpart to migration 0058 (Epic A.1):
 * after the column is added (NULL on every row), this job populates legacy
 * library rows by joining against `artists` in batched UPDATEs that each
 * commit independently. Once `artist_name` is populated, the STORED
 * `search_doc` tsvector becomes meaningful for those rows and the new
 * tsvector search path (A.5) starts returning matches.
 */

import { db } from '@wxyc/database';
import {
  applyBatch,
  runBackfill,
  verifyComplete,
  formatDuration,
  BATCH_SIZE,
} from '../../../../jobs/library-artist-name-backfill/job';

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

describe('library-artist-name-backfill: applyBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds an UPDATE that sets library.artist_name from the artists join', async () => {
    // The whole point of A.2 is to denormalize artists.artist_name onto
    // library.artist_name. Drift here would either copy the wrong column
    // or skip the join entirely.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 5000 });

    await applyBatch(5000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*library[\s\S]*artist_name/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/SET\s+"?artist_name"?\s*=\s*a\."artist_name"/i);
    expect(sqlText).toMatch(/FROM[\s\S]*"?artists"?\s+AS\s+a/i);
    expect(sqlText).toMatch(/a\."id"\s*=\s*l\."artist_id"/i);
  });

  it('restricts the UPDATE to NULL artist_name rows within a bounded batch', async () => {
    // Three regression guards in one test:
    //   - artist_name IS NULL on the outer UPDATE (don't overwrite live writes from A.3)
    //   - LIMIT in an inner SELECT (bounded batch — never an unbounded UPDATE)
    //   - artist_name IS NULL also on the inner SELECT (idempotent re-runs)
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 5000 });

    await applyBatch(5000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*library[\s\S]*artist_name/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/artist_name"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/LIMIT/i);
    // Inner SELECT for the bounded batch — there should be a SELECT inside the UPDATE.
    expect(sqlText).toMatch(/IN\s*\(\s*SELECT/i);
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
      /UPDATE[\s\S]*library[\s\S]*artist_name/i.test(renderSql(c[0]))
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

describe('library-artist-name-backfill: runBackfill loop control', () => {
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

  it('uses BATCH_SIZE of 5000 (not unbounded)', () => {
    // Bounded UPDATEs are the whole point. If a future change accidentally bumps
    // the batch size into the millions or removes the LIMIT, this test catches it.
    expect(BATCH_SIZE).toBe(5000);
  });
});

describe('library-artist-name-backfill: verifyComplete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes when zero library rows have NULL artist_name', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ missing: 0 }]);

    await expect(verifyComplete()).resolves.toBeUndefined();
  });

  it('throws with a remediation hint when library rows still have NULL artist_name', async () => {
    // mockResolvedValue (not Once) so both rejection assertions get the
    // same response — the second await re-invokes verifyComplete.
    (db.execute as jest.Mock).mockResolvedValue([{ missing: 137 }]);

    await expect(verifyComplete()).rejects.toThrow(/137 library row\(s\)/);
    await expect(verifyComplete()).rejects.toThrow(/idempotent/i);
  });
});

describe('library-artist-name-backfill: formatDuration', () => {
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
