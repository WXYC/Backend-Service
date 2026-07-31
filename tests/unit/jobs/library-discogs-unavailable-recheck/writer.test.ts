/**
 * Unit tests for jobs/library-discogs-unavailable-recheck writer.ts (BS#1283).
 *
 * Pins two load-bearing correctness properties from the parent issue:
 *   - Test 2 (sticky-false-match regression): the rotation UPDATE carries NO
 *     `discogs_release_id IS NULL` guard, so a stale false id is overwritten
 *     by a fresh high-confidence match.
 *   - Test 9 (multi-rotation-row): the rotation UPDATE's WHERE clause keys
 *     only on `album_id` (no row-count assumption), so every rotation row
 *     for the album is updated in one statement.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { stampRecheckTimestamp, writeMatch } from '../../../../jobs/library-discogs-unavailable-recheck/writer';

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

describe('writeMatch', () => {
  beforeEach(() => {
    chain.returning.mockReset();
    chain.set.mockClear();
    chain.where.mockClear();
    chain.update.mockClear();
  });

  test('overwrites discogs_release_id with no IS NULL guard (sticky-false-match regression, issue test 2)', async () => {
    // rotation UPDATE resolves first (1 stale row overwritten), library
    // UPDATE resolves second.
    chain.returning.mockResolvedValueOnce([{ id: 7001 }]).mockResolvedValueOnce([{ id: 42 }]);

    const result = await writeMatch(42, 99999);

    expect(result).toEqual({ written: true, rotationRowsUpdated: 1 });

    // First .set() call is the rotation UPDATE.
    const rotationSetArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(rotationSetArg.discogs_release_id).toBe(99999);
    expect(rotationSetArg.discogs_release_id_source).toBe('recheck_after_unavailable');
    // No IS NULL condition anywhere in the rotation UPDATE's WHERE args.
    const rotationWhereArg = chain.where.mock.calls[0]?.[0];
    expect(renderSql(rotationWhereArg)).not.toMatch(/IS NULL/i);

    // Second .set() call is the library UPDATE: flag + note cleared, timestamp stamped.
    const librarySetArg = chain.set.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(librarySetArg.discogs_unavailable).toBe(false);
    expect(librarySetArg.discogs_unavailable_note).toBeNull();
    expect(renderSql(librarySetArg.last_discogs_recheck_at)).toMatch(/now\(\)/i);
  });

  test('keys the rotation UPDATE on album_id only, updating every rotation row for the album (multi-rotation-row, issue test 9)', async () => {
    // Simulate 3 stale rotation rows for the same album_id all getting overwritten.
    chain.returning
      .mockResolvedValueOnce([{ id: 7001 }, { id: 7002 }, { id: 7003 }])
      .mockResolvedValueOnce([{ id: 42 }]);

    const result = await writeMatch(42, 99999);

    expect(result).toEqual({ written: true, rotationRowsUpdated: 3 });
  });

  test('reports written:false when the library UPDATE affects zero rows (album deleted mid-run)', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 7001 }]).mockResolvedValueOnce([]);

    const result = await writeMatch(42, 99999);

    expect(result).toEqual({ written: false, rotationRowsUpdated: 1 });
  });

  test('is transactional: both UPDATEs run inside db.transaction', async () => {
    chain.returning.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 42 }]);

    await writeMatch(42, 99999);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('stampRecheckTimestamp', () => {
  beforeEach(() => {
    chain.returning.mockReset();
    chain.set.mockClear();
  });

  test('stamps only last_discogs_recheck_at, touching neither the flag nor the note', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const result = await stampRecheckTimestamp(42);

    expect(result).toEqual({ written: true });
    const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(setArg)).toEqual(['last_discogs_recheck_at']);
    expect(renderSql(setArg.last_discogs_recheck_at)).toMatch(/now\(\)/i);
  });

  test('returns written:false when the UPDATE affects zero rows', async () => {
    chain.returning.mockResolvedValueOnce([]);

    const result = await stampRecheckTimestamp(42);

    expect(result).toEqual({ written: false });
  });
});
