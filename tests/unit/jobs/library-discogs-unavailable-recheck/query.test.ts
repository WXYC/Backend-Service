/**
 * Unit tests for jobs/library-discogs-unavailable-recheck query.ts (BS#1283).
 *
 * Pins the candidate predicate: `library` rows flagged `discogs_unavailable`
 * outside the 7-day recheck window, `NULLS FIRST` priority, `LIMIT`-bounded.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { loadCandidates } from '../../../../jobs/library-discogs-unavailable-recheck/query';

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

describe('loadCandidates', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  test('selects library rows flagged discogs_unavailable, not rotation rows', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      { id: 42, artist_name: 'Chuquimamani-Condori', album_title: 'Edits' },
    ]);

    const rows = await loadCandidates(50);

    expect(rows).toEqual([{ id: 42, artist_name: 'Chuquimamani-Condori', album_title: 'Edits' }]);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?library"?/i);
    expect(text).not.toMatch(/FROM\s+"?wxyc_schema"?\."?rotation"?/i);
    expect(text).toMatch(/"discogs_unavailable"\s*=\s*true/i);
    expect(text).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"album_title"\s+IS\s+NOT\s+NULL/i);
  });

  test('gives never-rechecked rows priority via NULLS FIRST, then bounds with LIMIT', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(25);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/ORDER BY\s+"last_discogs_recheck_at"\s+NULLS FIRST,\s*"id"\s+ASC/i);
    expect(text).toContain('LIMIT');
  });

  test('excludes rows rechecked within the 7-day window and includes rows outside it', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(50);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toContain('"last_discogs_recheck_at" IS NULL');
    expect(text).toContain('"last_discogs_recheck_at" <= now() - (interval');
    expect(text).toContain("interval '1 day'");
  });
});
