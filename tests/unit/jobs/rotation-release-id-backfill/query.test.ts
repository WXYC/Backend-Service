/**
 * Unit tests for jobs/rotation-release-id-backfill query.ts (BS#1813).
 *
 * Pins the recurring resolver's retry predicate: active rotation rows with
 * NULL `discogs_release_id` remain the idempotent candidate set, but definitive
 * no-match/trust-rejected attempts are suppressed until the marker exits the
 * no-match TTL window.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { loadCandidates } from '../../../../jobs/rotation-release-id-backfill/query';

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

  test('selects active unresolved rotation rows and keeps discogs_release_id IS NULL as the idempotency gate', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      { id: 42, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ]);

    const rows = await loadCandidates(30);

    expect(rows).toEqual([{ id: 42, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' }]);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?rotation"?/i);
    expect(text).toMatch(/"kill_date"\s+IS\s+NULL\s+OR\s+"kill_date"\s+>\s+CURRENT_DATE/i);
    expect(text).toMatch(/"discogs_release_id"\s+IS\s+NULL/i);
    expect(text).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"album_title"\s+IS\s+NOT\s+NULL/i);
  });

  test('suppresses stamped no-match rows inside the TTL and permits them after the TTL', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toContain('"discogs_release_id_resolve_attempted_at" IS NULL');
    expect(text).toContain('"discogs_release_id_resolve_attempted_at" <= now() - (interval');
    expect(text).toContain("interval '1 day'");
  });

  test('does not key off tubafrenzy provenance', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(30);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).not.toMatch(/tubafrenzy_paste/i);
    expect(text).not.toMatch(/discogs_release_id_source\s*=/i);
  });
});
