import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

// BS#1885: an alias-only primary result set must not suppress the
// catalog-track-search cascade. These tests pin the new gate
// (`totalNonAlias` from the count query) and the merge-instead-of-replace
// behavior in `library-search.service.ts::searchLibrary`.
//
// Mocks `library.service`'s `runCatalogTrackSearchCascade` directly (mirrors
// `library-search.cascade-span.test.ts`) rather than extending
// `library-search-alias.test.ts` — that file already imports the *real*
// `library.service` for its Both-mode describes, and Jest's module mock
// registry is per-file, so a real and a mocked `library.service` can't
// coexist in one file.

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
import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';

const PARAMS = {
  q: 'Thee Oh Sees',
  page: 0,
  limit: 25,
  sort: 'artist' as const,
  order: 'asc' as const,
};

const baseQueryRow = {
  id: 42,
  add_date: '2024-01-15',
  album_title: 'A Weird Exits',
  artist_name: 'OHSEES',
  code_letters: 'OH',
  code_number: 1,
  code_artist_number: 7,
  format_name: 'CD',
  genre_name: 'Rock',
  label: 'Castle Face',
  label_id: null,
  rotation_bin: null,
  plays: 7,
  on_streaming: true,
  album_artist: null,
};

function aliasRow(overrides: Partial<typeof baseQueryRow> & { id: number }, variant: string) {
  return {
    ...baseQueryRow,
    ...overrides,
    alias_max_sim: 0.4,
    alias_matched_variant: variant,
    alias_matched_source: 'discogs_name_variation',
  };
}

// Full LibraryArtistViewEntry shape a mocked `runCatalogTrackSearchCascade`
// resolves — mirrors `baseViewRow` in library-search-alias.test.ts.
function cascadeRow(overrides: Record<string, unknown> & { id: number }) {
  return {
    id: 99,
    code_letters: 'CS',
    code_artist_number: 1,
    code_number: 1,
    artist_name: 'Chiastic Slide Artist',
    alphabetical_name: 'Chiastic Slide Artist',
    album_title: 'Chiastic Slide',
    format_name: 'CD',
    genre_name: 'Electronic',
    rotation_bin: null,
    add_date: new Date('2024-02-01'),
    label: 'Warp Records',
    label_id: null,
    on_streaming: true,
    album_artist: null,
    plays: 3,
    artwork_url: null,
    artist_id: 8001,
    discogs_artist_id: null,
    musicbrainz_artist_id: null,
    wikidata_qid: null,
    spotify_artist_id: null,
    apple_music_artist_id: null,
    bandcamp_id: null,
    matched_via: [{ title: 'Nuane', artist_credit: null, position: '1', confidence: 0.95, source: 'discogs_master' }],
    ...overrides,
  };
}

function enableAlias(): void {
  process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
  resetCatalogSearchAliasConfig();
}

describe('searchLibrary — alias-only primary no longer suppresses the cascade (BS#1885)', () => {
  const originalFlag = process.env.CATALOG_SEARCH_ALIAS_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunCatalogTrackSearchCascade.mockReset().mockResolvedValue([]);
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
    db.execute.mockReset();
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    else process.env.CATALOG_SEARCH_ALIAS_ENABLED = originalFlag;
    resetCatalogSearchAliasConfig();
  });

  it('case 1: alias-only primary — cascade runs and its row merges with the surviving alias rows', async () => {
    enableAlias();
    db.execute
      .mockResolvedValueOnce([aliasRow({ id: 43, artist_name: 'Duane Allman' }, 'Duane'), aliasRow({ id: 44, artist_name: 'Duane Pitre' }, 'Duane')])
      .mockResolvedValueOnce([{ total: 4, total_non_alias: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([cascadeRow({ id: 99 })]);

    const { results, total } = await searchLibrary(PARAMS);

    expect(mockRunCatalogTrackSearchCascade).toHaveBeenCalledTimes(1);
    const cascadeHit = results.find((r) => r.id === 99);
    expect(cascadeHit).toBeDefined();
    expect(cascadeHit?.matched_via).toEqual(cascadeRow({ id: 99 }).matched_via);
    const aliasHits = results.filter((r) => r.id === 43 || r.id === 44);
    expect(aliasHits).toHaveLength(2);
    aliasHits.forEach((r) => expect(r.matched_via_alias).toBeDefined());
    // total (4) + added cascade rows not already present in the alias page (1)
    expect(total).toBe(5);
  });

  it('case 2: mixed primary (a non-alias row present) — cascade never runs', async () => {
    enableAlias();
    db.execute
      .mockResolvedValueOnce([{ ...baseQueryRow, alias_max_sim: null, alias_matched_variant: null, alias_matched_source: null }])
      .mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);

    const { results, total } = await searchLibrary(PARAMS);

    expect(mockRunCatalogTrackSearchCascade).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(total).toBe(1);
  });

  it('case 3: alias-only primary + cascade finds nothing — alias rows returned unchanged', async () => {
    enableAlias();
    db.execute
      .mockResolvedValueOnce([aliasRow({ id: 43, artist_name: 'Duane Allman' }, 'Duane')])
      .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([]);

    const { results, total } = await searchLibrary(PARAMS);

    expect(mockRunCatalogTrackSearchCascade).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(43);
    expect(results[0].matched_via_alias).toBeDefined();
    expect(total).toBe(1);
  });

  it('case 4: id collision — the cascade row and an alias row share an id and merge into one', async () => {
    enableAlias();
    db.execute
      .mockResolvedValueOnce([aliasRow({ id: 42, artist_name: 'OHSEES' }, 'Thee Oh Sees')])
      .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([cascadeRow({ id: 42 })]);

    const { results, total } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(42);
    expect(results[0].matched_via).toEqual(cascadeRow({ id: 42 }).matched_via);
    expect(results[0].matched_via_alias).toEqual([{ matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' }]);
    // The colliding cascade row isn't a NEW row, so total isn't inflated.
    expect(total).toBe(1);
  });

  it('case 5: flag off — gate is byte-identical to pre-fix behavior, no total_non_alias in the SQL', async () => {
    db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

    const { results, total } = await searchLibrary(PARAMS);

    expect(mockRunCatalogTrackSearchCascade).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(total).toBe(1);
    const countCall = db.execute.mock.calls[1]?.[0];
    expect(JSON.stringify(countCall ?? '')).not.toContain('total_non_alias');
  });

  it('case 5b: flag off + zero primary rows — cascade still runs on a genuine 0-hit (pre-fix behavior)', async () => {
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([cascadeRow({ id: 99 })]);

    const { results, total } = await searchLibrary(PARAMS);

    expect(mockRunCatalogTrackSearchCascade).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(99);
    expect(total).toBe(1);
  });
});
