/**
 * Unit tests for enrichment-worker claim.ts (BS#892 / Epic C C2).
 *
 * Pins the idempotent claim contract that lets N consumer instances all
 * receive the same CDC event safely: the first instance to win the atomic
 * `UPDATE ... WHERE metadata_status='pending'` does the LML work, every
 * other instance sees `RETURNING []` and skips. The 5-state enum
 * (`pending`, `enriching`, `enriched_match`, `enriched_no_match`,
 * `failed_no_retry`) was added in BS#891.
 *
 * Three contract guarantees:
 *   1. On a `pending` row, the claim flips to `enriching` and stamps
 *      `enriching_since = now()`. Returns `{ claimed: true, id }`.
 *   2. On a row already in `enriching` (a sibling consumer beat us), the
 *      UPDATE matches 0 rows. Returns `{ claimed: false }`. No error.
 *   3. On a row in any terminal state (`enriched_match`,
 *      `enriched_no_match`, `failed_no_retry`), the UPDATE matches 0 rows.
 *      Returns `{ claimed: false }`. No error.
 *
 * The WHERE clause MUST narrow by both `id` and `metadata_status='pending'`
 * — narrowing by id alone would silently overwrite an in-flight or
 * terminal-state row, breaking the N×N safety contract.
 */
import { jest } from '@jest/globals';

import { db, flowsheet } from '@wxyc/database';
import { claimRowForEnrichment } from '../../../../apps/enrichment-worker/claim';

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

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: { set: jest.Mock; where: jest.Mock; returning: jest.Mock };
};

describe('claimRowForEnrichment (BS#892)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('claims a pending row: flips to enriching with enriching_since stamp', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const result = await claimRowForEnrichment(42);

    expect(result).toEqual({ claimed: true, id: 42 });
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriching');
    expect(renderSql(setCall.enriching_since)).toContain('now()');
  });

  it('narrows the WHERE by id AND metadata_status=pending', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await claimRowForEnrichment(42);

    const whereCall = mockDb._chain.where.mock.calls[0]?.[0];
    const whereSql = renderSql(whereCall);
    // Drizzle binds `id` as a parameter (renders as a placeholder gap, not
    // an inlined literal), so the assertion shape is: column refs and the
    // literal 'pending' must appear; the bound id is checked by the
    // happy-path test above via the resolved RETURNING.
    expect(whereSql).toContain('"id"');
    expect(whereSql).toContain('"metadata_status"');
    expect(whereSql).toContain("'pending'");
  });

  it('returns claimed:false when a sibling consumer already claimed the row (enriching)', async () => {
    // Sibling won; our UPDATE matches 0 rows because metadata_status is now
    // 'enriching', not 'pending'.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const result = await claimRowForEnrichment(42);

    expect(result).toEqual({ claimed: false });
  });

  it('returns claimed:false when the row is already in a terminal state', async () => {
    // The row was enriched (enriched_match / enriched_no_match /
    // failed_no_retry) before we got the event. Same 0-row UPDATE.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const result = await claimRowForEnrichment(42);

    expect(result).toEqual({ claimed: false });
  });

  it('propagates DB errors instead of swallowing them', async () => {
    const dbError = new Error('connection refused');
    mockDb._chain.returning.mockRejectedValueOnce(dbError);

    await expect(claimRowForEnrichment(42)).rejects.toThrow('connection refused');
  });
});
