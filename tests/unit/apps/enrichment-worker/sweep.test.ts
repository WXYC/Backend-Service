/**
 * Unit tests for enrichment-worker sweep.ts (BS#1225 / Epic C C6 split).
 *
 * Pins the stranded-claim recovery query shape so a schema change or an
 * accidental WHERE-loosening fails CI before deploy.
 *
 * The sweep flips `metadata_status='enriching'` rows whose `enriching_since`
 * is older than the 60s TTL back to `'pending'` (and NULLs `enriching_since`)
 * so the next CDC tick can re-claim them. Without it, every LML throw or
 * worker SIGTERM leaks a row in `enriching` forever — the C2 worker (#892)
 * documents this in `handler.ts:90-115` and tests/integration/
 * enrichment-worker-claim.spec.js:175-205 exercises the SQL inline.
 *
 * Three contract guarantees pinned here:
 *   1. WHERE narrows by `metadata_status='enriching'`. Loosening this would
 *      revert terminal rows back to pending, re-enqueueing finished work.
 *   2. WHERE narrows by `enriching_since < now() - interval '60 seconds'`.
 *      The 60s TTL is the partial index's predicate; loosening it (or
 *      forgetting the cutoff entirely) would race in-flight claims.
 *   3. SET writes `metadata_status='pending'` AND `enriching_since=NULL`.
 *      Forgetting the NULL would leave a stale enriching_since the next
 *      claim-then-strand cycle has to overwrite.
 *
 * Integration coverage of the end-to-end recovery cycle (claim → strand →
 * sweep → re-claim) lives in `tests/integration/enrichment-worker-claim.spec.js`.
 */
import { jest } from '@jest/globals';

import { db, flowsheet } from '@wxyc/database';
import { sweepStrandedClaims } from '../../../../apps/enrichment-worker/sweep';

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

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: { set: jest.Mock; where: jest.Mock; returning: jest.Mock };
};

describe('sweepStrandedClaims (BS#1225)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates the flowsheet table', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    await sweepStrandedClaims();

    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
  });

  it('SET flips metadata_status back to pending and NULLs enriching_since', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    await sweepStrandedClaims();

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('pending');
    expect(setCall.enriching_since).toBeNull();
  });

  it('WHERE references both the enriching guard and the 60-second cutoff', async () => {
    // The WHERE uses a raw `sql\`...\`` chunk (codebase convention for
    // multi-predicate partial-index queries; mirrors the `schema.ts`
    // index definitions). Render the chunk and assert both the
    // metadata_status='enriching' guard and the 60-second TTL cutoff are
    // present — a future "drop the status guard" or "bump to 30s" edit
    // is caught here.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    await sweepStrandedClaims();

    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    expect(whereArg).toBeDefined();
    const rendered = renderSql(whereArg);
    expect(rendered).toContain("'enriching'");
    expect(rendered).toContain('60 seconds');
  });

  it('returns the recovered row count', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const recovered = await sweepStrandedClaims();

    expect(recovered).toBe(3);
  });

  it('returns 0 when nothing was stranded', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const recovered = await sweepStrandedClaims();

    expect(recovered).toBe(0);
  });

  it('propagates DB errors instead of swallowing them', async () => {
    const dbError = new Error('connection refused');
    mockDb._chain.returning.mockRejectedValueOnce(dbError);

    await expect(sweepStrandedClaims()).rejects.toThrow('connection refused');
  });
});
