/**
 * Unit tests for jobs/rotation-release-id-backfill writer.ts (BS#1029).
 *
 * The writer translates an in-memory (rotation_id, release_id) pair into a
 * single UPDATE … WHERE discogs_release_id IS NULL. The WHERE clause is the
 * race guard: if a tubafrenzy paste landed mid-run, the UPDATE affects 0
 * rows and the writer reports `written: false` so the orchestrator can
 * surface it on its `raced` counter (BS#1029 acceptance criterion).
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { markReleaseIdResolveAttempted, writeReleaseId } from '../../../../jobs/rotation-release-id-backfill/writer';

type MockChain = Record<string, jest.Mock>;
const chain = (db as unknown as { _chain: MockChain })._chain;

type SqlLike = {
  sql?: string | string[];
  raw?: string;
  queryChunks?: Array<string | { value?: string | string[]; raw?: string }>;
};

const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (typeof chunk.raw === 'string') return chunk.raw;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

describe('writeReleaseId', () => {
  beforeEach(() => {
    chain.returning.mockReset();
  });

  test('returns written:true when the UPDATE affects one row (resolved happy path)', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const result = await writeReleaseId(42, 999001);

    expect(result).toEqual({ written: true });
    expect(chain.update).toHaveBeenCalled();
    const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.discogs_release_id).toBe(999001);
    expect(setArg.discogs_release_id_source).toBe('lml_offline_backfill');
    expect(renderSql(setArg.discogs_release_id_resolve_attempted_at)).toMatch(/now\(\)/i);
  });

  test('returns written:false when the UPDATE affects zero rows (race with tubafrenzy paste)', async () => {
    // The WHERE clause is `id = $1 AND discogs_release_id IS NULL`. If a
    // tubafrenzy paste landed between the orchestrator's SELECT and this
    // UPDATE, the row's discogs_release_id is no longer NULL and the
    // UPDATE matches zero rows. `.returning()` resolves to [].
    chain.returning.mockResolvedValueOnce([]);

    const result = await writeReleaseId(42, 999001);

    expect(result).toEqual({ written: false });
  });
});

describe('markReleaseIdResolveAttempted', () => {
  beforeEach(() => {
    chain.returning.mockReset();
  });

  test('stamps only the attempt marker for definitive no-match/trust-rejected outcomes', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 99 }]);

    const result = await markReleaseIdResolveAttempted(99);

    expect(result).toEqual({ written: true });
    const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(setArg)).toEqual(['discogs_release_id_resolve_attempted_at']);
    expect(renderSql(setArg.discogs_release_id_resolve_attempted_at)).toMatch(/now\(\)/i);
  });

  test('returns written:false when the marker UPDATE loses the discogs_release_id IS NULL race', async () => {
    chain.returning.mockResolvedValueOnce([]);

    const result = await markReleaseIdResolveAttempted(99);

    expect(result).toEqual({ written: false });
  });
});
