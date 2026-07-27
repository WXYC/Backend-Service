/**
 * Unit tests for album-critic-reviews-etl's antijoin.ts (BS#1830).
 *
 * `loadExistingPairs` reads via `db.execute(sql...)` (the donor's
 * `link.ts` idiom — see antijoin.ts's module docstring for why the
 * query-builder `inArray()` path isn't usable against the shared test
 * mock). `filterNew` is pure and pinned separately from the SQL shape.
 */
import { db } from '@wxyc/database';
import { loadExistingPairs, filterNew, pairKey } from '../../../../jobs/album-critic-reviews-etl/antijoin';
import type { CorpusItem } from '../../../../jobs/album-critic-reviews-etl/manifest';

type MockDb = typeof db & { _chain: { execute: jest.Mock } };
const mockDb = db as MockDb;

const item = (sourceUrl: string): CorpusItem => ({
  artist: 'Jessica Pratt',
  album: 'On Your Own Love Again',
  source: 'The Quietus',
  sourceUrl,
  articleText: 'text',
});

describe('loadExistingPairs', () => {
  beforeEach(() => {
    mockDb._chain.execute.mockClear();
  });

  it('returns an empty set without touching the DB when albumIds is empty', async () => {
    const existing = await loadExistingPairs([]);
    expect(existing.size).toBe(0);
    expect(mockDb._chain.execute).not.toHaveBeenCalled();
  });

  it('builds a pairKey set from the returned rows', async () => {
    mockDb._chain.execute.mockResolvedValueOnce([
      { album_id: 1, source_url: 'https://a.example/1' },
      { album_id: 2, source_url: 'https://b.example/2' },
    ]);
    const existing = await loadExistingPairs([1, 2]);
    expect(existing.has(pairKey(1, 'https://a.example/1'))).toBe(true);
    expect(existing.has(pairKey(2, 'https://b.example/2'))).toBe(true);
    expect(existing.size).toBe(2);
  });

  it('handles the node-postgres { rows } result shape', async () => {
    mockDb._chain.execute.mockResolvedValueOnce({ rows: [{ album_id: 5, source_url: 'https://c.example/5' }] });
    const existing = await loadExistingPairs([5]);
    expect(existing.has(pairKey(5, 'https://c.example/5'))).toBe(true);
  });

  it('throws on an unrecognized db.execute() result shape', async () => {
    mockDb._chain.execute.mockResolvedValueOnce('not an array or {rows}');
    await expect(loadExistingPairs([1])).rejects.toThrow(/unrecognized/);
  });
});

describe('filterNew', () => {
  it('drops deduped items whose (albumId, sourceUrl) pair already exists', () => {
    const deduped = [
      { item: item('https://a.example/1'), albumId: 1 },
      { item: item('https://a.example/2'), albumId: 1 },
    ];
    const existing = new Set([pairKey(1, 'https://a.example/1')]);
    const result = filterNew(deduped, existing);
    expect(result).toHaveLength(1);
    expect(result[0].item.sourceUrl).toBe('https://a.example/2');
  });

  it('keeps everything when nothing already exists', () => {
    const deduped = [{ item: item('https://a.example/1'), albumId: 1 }];
    const result = filterNew(deduped, new Set());
    expect(result).toHaveLength(1);
  });

  it('a NEW source_url for an album that already carries a different card is NOT filtered (multi-source cards)', () => {
    // Documents the issue's step-4 interaction: dedup can pick a different
    // winning source_url on a later run than what's already stored; the
    // anti-join is keyed on the PAIR, not the album alone, so this new pair
    // is correctly treated as new, not already-present.
    const deduped = [{ item: item('https://new-source.example/1'), albumId: 1 }];
    const existing = new Set([pairKey(1, 'https://old-source.example/1')]);
    const result = filterNew(deduped, existing);
    expect(result).toHaveLength(1);
  });
});
