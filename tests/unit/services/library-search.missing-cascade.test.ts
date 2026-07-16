import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

// BS#1552 regression pin. `GET /library/query` must only skip the track-title
// cascade when `missing=true` (cascade rows carry no date_lost/date_found, so
// they can never be known-missing). `missing=false` is the dj-site catalog's
// default "hide lost records" filter — the cascade rows are, by construction,
// non-missing albums and MUST still run, or catalog track-title search is dead
// on that surface. The pre-fix guard `if (params.missing !== undefined)` killed
// the cascade for both truthy and falsy `missing`.

const mockRunCatalogTrackSearchCascade = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

jest.mock('../../../apps/backend/services/library.service', () => ({
  runCatalogTrackSearchCascade: mockRunCatalogTrackSearchCascade,
}));

type SpanLike = { setAttribute: jest.Mock; setAttributes: jest.Mock };
type SpanOpts = { name: string; op: string; attributes?: Record<string, unknown> };
const spanInstance: SpanLike = { setAttribute: jest.fn(), setAttributes: jest.fn() };
const mockStartSpan = jest.fn(<T>(_opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
  Promise.resolve(callback(spanInstance))
);
jest.mock('@sentry/node', () => ({
  startSpan: <T>(opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    mockStartSpan(opts, callback),
  getActiveSpan: () => spanInstance,
}));

import { searchLibrary } from '../../../apps/backend/services/library-search.service';

const PARAMS = {
  q: 'vi scose poise',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

// A cascade-only hit — a present, non-missing album that matches only through
// the track-title cascade (no direct artist/album/label match on the primary
// SELECT). Shaped as the `TaggedLibraryViewEntry` that
// `runCatalogTrackSearchCascade` returns.
const cascadeHit = {
  id: 314,
  add_date: '2024-03-01',
  album_title: 'DOGA',
  artist_name: 'Juana Molina',
  code_letters: 'JU',
  code_number: 1,
  code_artist_number: 4,
  format_name: 'CD',
  genre_name: 'Rock',
  label: 'Sonamos',
  label_id: null,
  rotation_bin: null,
  plays: 12,
  on_streaming: true,
  album_artist: null,
};

function primeEmptyPrimary(): void {
  // Two `db.execute` calls in `searchLibrary` (data + count via Promise.all).
  // Empty data + total=0 forces the post-empty branch where the cascade gate
  // (and the `missing` guard) is consulted.
  db.execute.mockReset();
  db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
}

describe('searchLibrary missing-filter cascade guard (BS#1552)', () => {
  beforeEach(() => {
    mockStartSpan.mockClear();
    mockRunCatalogTrackSearchCascade.mockReset();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([]);
  });

  it('missing=false still runs the cascade and returns the cascade-only hit', async () => {
    primeEmptyPrimary();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([cascadeHit]);

    const { results, total } = await searchLibrary({ ...PARAMS, missing: false });

    expect(mockRunCatalogTrackSearchCascade).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(314);
    expect(total).toBe(1);
  });

  it('missing=true still skips the cascade (existing behavior preserved)', async () => {
    primeEmptyPrimary();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([cascadeHit]);

    const { results, total } = await searchLibrary({ ...PARAMS, missing: true });

    expect(mockRunCatalogTrackSearchCascade).not.toHaveBeenCalled();
    expect(mockStartSpan).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('missing omitted still runs the cascade (unchanged)', async () => {
    primeEmptyPrimary();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([cascadeHit]);

    const { results } = await searchLibrary({ ...PARAMS });

    expect(mockRunCatalogTrackSearchCascade).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(314);
  });
});
