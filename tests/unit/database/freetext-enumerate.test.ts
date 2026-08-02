/**
 * Unit tests for shared/database/src/freetext-enumerate.ts (BS#1767 SQL
 * shape; extracted from jobs/catalog-popularity-freetext-resolve/job.ts by
 * BS#1799 so the tests/integration babel-jest harness — which can't import
 * the job directly — can import and execute this SAME statement instead of
 * hand-duplicating a SQL mirror). Tests the REAL module directly (bypassing
 * the package-level `@wxyc/database` mock, mirroring
 * tests/unit/database/concerts-recompute.test.ts and live-activity.test.ts)
 * so the SQL text asserted below is the module's actual output, not a
 * hand-duplicated stub.
 *
 * `jobs/catalog-popularity-freetext-resolve/job.ts` imports + re-exports
 * `enumerateFreetextPairs` from `@wxyc/database` as a thin pass-through; its
 * own unit suite (tests/unit/jobs/catalog-popularity-freetext-resolve/job.test.ts)
 * no longer tests this function directly.
 *
 * SQL-contract test pins: the DISTINCT ON (artist_name, album_title)
 * selection + its three required predicates, the inner GROUP BY play-count
 * shape, the full non-empty-first / most-played / deterministic-tiebreak
 * ORDER BY sequence (the drift tripwire the integration spec's runtime
 * semantics check depends on), and the SET LOCAL statement_timeout wrapper.
 * Mapping tests pin the `{ artist, album, song }` shape, including the
 * track-less-pair-collapses-to-'' rule.
 */
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { db } from '../../mocks/database.mock';
import { enumerateFreetextPairs } from '../../../shared/database/src/freetext-enumerate';

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

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined =>
  (db.execute as jest.Mock).mock.calls.find((call) => pattern.test(renderSql(call[0])));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('enumerateFreetextPairs', () => {
  it('selects DISTINCT ON (artist_name, album_title) with the three required predicates', async () => {
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'J Dilla', album_title: 'Donuts', track_title: 'Waves' },
    ]);

    await enumerateFreetextPairs();

    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/DISTINCT\s+ON\s*\(\s*"?artist_name"?\s*,\s*"?album_title"?\s*\)/i);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"?entry_type"?\s*=\s*'track'/i);
    expect(text).toMatch(/"?album_id"?\s+IS\s+NULL/i);
    expect(text).toMatch(/"?artist_name"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"?album_title"?\s+IS\s+NOT\s+NULL/i);
    // Representative track_title is returned but NEVER filtered — a track-less
    // pair must still fall back to album-only, not be dropped from the scan.
    expect(text).toMatch(/"?track_title"?/i);
    expect(text).not.toMatch(/"?track_title"?\s+IS\s+NOT\s+NULL/i);
  });

  it('groups by (artist, album, track) and orders by non-empty-first, then most-played, then deterministic', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs();
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    const text = renderSql(call?.[0]);
    // Inner GROUP BY counts plays per distinct track so the modal one can win.
    expect(text).toMatch(/GROUP\s+BY\s+"?artist_name"?\s*,\s*"?album_title"?\s*,\s*"?track_title"?/i);
    expect(text).toMatch(/count\s*\(\s*\*\s*\)\s+AS\s+play_count/i);
    // Pin the FULL ORDER BY sequence IN ORDER — this is the drift tripwire on
    // the real query (the integration spec validates this same shape's runtime
    // semantics against real PG). A flipped ASC/DESC, a dropped btrim
    // non-empty-first term, or a reordered tiebreak all fail HERE, on the real
    // function's emitted SQL. Whitespace is collapsed first so the assertion is
    // a single flat pattern (avoids a nest of `\s*` quantifiers):
    //   artist_name, album_title,
    //   (btrim(coalesce(track_title,'')) = '') ASC,   -- non-empty first
    //   play_count DESC,                              -- most-played wins
    //   track_title ASC                               -- deterministic tiebreak
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('ORDER BY "artist_name", "album_title",');
    expect(flat).toContain(`(btrim(coalesce("track_title", '')) = '') ASC, play_count DESC, "track_title" ASC`);
  });

  it('wraps the SELECT in a transaction + SET LOCAL statement_timeout', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs(99_000);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    const setLocalCall = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(renderSql(setLocalCall?.[0])).toMatch(/99000ms/);
  });

  it('maps rows to { artist, album, song } using the representative track_title', async () => {
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'Kendrick Lamar', album_title: 'DAMN.', track_title: 'HUMBLE.' },
    ]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'Kendrick Lamar', album: 'DAMN.', song: 'HUMBLE.' }]);
  });

  it('maps a null/missing track_title to an empty song (track-less pairs still fall back to album-only)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ artist_name: 'J Dilla', album_title: 'Donuts', track_title: null }]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'J Dilla', album: 'Donuts', song: '' }]);
  });

  it('trims a whitespace-only track_title to an empty song at the enumerate boundary', async () => {
    // The "usable track?" rule lives HERE (the single trim boundary): a
    // whitespace-only representative maps to song='' so buildBulkItems can use
    // a plain truthiness check downstream.
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'J Dilla', album_title: 'Donuts', track_title: '   ' },
    ]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'J Dilla', album: 'Donuts', song: '' }]);
  });

  it('trims surrounding whitespace off a usable track_title', async () => {
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'J Dilla', album_title: 'Donuts', track_title: '  Waves  ' },
    ]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'J Dilla', album: 'Donuts', song: 'Waves' }]);
  });
});
