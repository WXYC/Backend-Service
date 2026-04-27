/**
 * Unit tests for the flowsheet linkage-audit backfill job.
 *
 * Counterpart to the DDL-only migration 0062: after the columns ship NULL on
 * every row, this job classifies legacy linked rows by where their album_id
 * came from. ETL-linked rows (those with a legacy_release_id) → 'etl_legacy_id'.
 * Anything else with album_id IS NOT NULL → 'dj_bin_pick' (best guess for
 * recent inserts that were resolved through the catalog-search path).
 */

import { db } from '@wxyc/database';
import { applyBatch, runBackfill, BATCH_SIZE } from '../../../../jobs/flowsheet-linkage-audit-backfill/job';

type SqlLike = {
  sql?: string | string[];
  queryChunks?: Array<string | { value?: string | string[] }>;
};
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

describe('flowsheet-linkage-audit-backfill: applyBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('classifies ETL-linked rows as etl_legacy_id and others as dj_bin_pick', async () => {
    // Backfill rule from the issue body: rows with legacy_release_id set
    // came from the ETL → 'etl_legacy_id'. Anything else with album_id set
    // is a best-guess DJ bin pick.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 5000 });

    await applyBatch(5000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*linkage_source/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/CASE\s+WHEN[\s\S]*legacy_release_id[\s\S]*IS\s+NOT\s+NULL[\s\S]*'etl_legacy_id'/i);
    expect(sqlText).toMatch(/ELSE\s+'dj_bin_pick'/i);
  });

  it('sets linked_at from add_time so the audit reflects when linkage actually happened', async () => {
    // Using NOW() would lie about legacy linkage timestamps. add_time is the
    // closest proxy we have — for ETL-imported rows this is the play time,
    // for DJ bin picks it is when the row was inserted (and linked).
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 5000 });

    await applyBatch(5000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*linked_at/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/"linked_at"\s*=\s*[a-z_.]*"?add_time"?/i);
  });

  it('restricts the UPDATE to album_id IS NOT NULL AND linkage_source IS NULL within a bounded LIMIT batch', async () => {
    // Three regression guards:
    //   - album_id IS NOT NULL (only rows that have a linkage to audit)
    //   - linkage_source IS NULL (idempotency: re-run skips already-classified)
    //   - LIMIT in an inner SELECT (bounded — never an unbounded UPDATE
    //     that would hold a write lock for hours, per issue #511)
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 5000 });

    await applyBatch(5000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*linkage_source/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/album_id"?\s+IS\s+NOT\s+NULL/i);
    expect(sqlText).toMatch(/linkage_source"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/LIMIT/i);
  });

  it('passes the batch size argument through into the SQL builder', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await applyBatch(1234);

    const call = (db.execute as jest.Mock).mock.calls.find((c) =>
      /UPDATE[\s\S]*flowsheet[\s\S]*linkage_source/i.test(renderSql(c[0]))
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

describe('flowsheet-linkage-audit-backfill: runBackfill loop control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('iterates batches until applyBatch returns 0 (natural end)', async () => {
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
    // Bounded UPDATEs are how this job avoids lock contention. If a future
    // change accidentally bumps this into the millions or removes the LIMIT,
    // it will reproduce the issue #511 incident.
    expect(BATCH_SIZE).toBe(5000);
  });
});
