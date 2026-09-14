import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * BS#2492: `urls` must reach `AlbumSearchResultRow` from the release-level
 * `library_urls` store, RELEASE-SCOPED and UNCONDITIONAL — unlike `card` /
 * `rotation_bin`, which ride the CURRENT_DATE-filtered rotation JOIN and vanish
 * when the release stops rotating. A release's definitive links persist, so a
 * non-rotating (or killed-rotation) hit still carries them.
 *
 * These tests pin the raw-row MAPPER (`toAlbumSearchResultRow`) and the cascade
 * MAPPER (`taggedRowToAlbumSearchResultRow`): `db.execute` is a bare mock that
 * ignores the SQL, so each fixture supplies `urls` (the `array_agg` result) by
 * hand — exactly the convention `library-search.card.test.ts` uses for the four
 * flat card columns. That the projection actually SELECTs `library_urls`
 * release-scoped (no CURRENT_DATE predicate), position-ordered, and that a
 * killed rotation still returns its links is the integration suite's job,
 * against real SQL (`tests/integration/library-urls-projection.spec.js`).
 */

const mockRunCatalogTrackSearchCascade = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

jest.mock('../../../apps/backend/services/library.service', () => ({
  runCatalogTrackSearchCascade: mockRunCatalogTrackSearchCascade,
}));

type SpanLike = { setAttribute: jest.Mock; setAttributes: jest.Mock };
type SpanOpts = { name: string; op: string; attributes?: Record<string, unknown> };
const spanInstance: SpanLike = { setAttribute: jest.fn(), setAttributes: jest.fn() };
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    Promise.resolve(callback(spanInstance)),
  getActiveSpan: () => spanInstance,
}));

import { searchLibrary } from '../../../apps/backend/services/library-search.service';
import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';

const PARAMS = {
  q: 'juana molina',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

function primaryRow(overrides: Record<string, unknown> = {}) {
  return {
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
    card_id: null,
    card_bin: null,
    card_number: null,
    card_name: null,
    urls: null,
    plays: 12,
    on_streaming: true,
    album_artist: null,
    discogs_unavailable: false,
    discogs_unavailable_note: null,
    last_discogs_recheck_at: null,
    artist_id: 4200,
    ...overrides,
  };
}

describe('searchLibrary: urls on AlbumSearchResultRow (BS#2492)', () => {
  beforeEach(() => {
    db.execute.mockReset();
    mockRunCatalogTrackSearchCascade.mockReset();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([]);
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
  });

  it('raw-row mapper: carries the release links in the projected order', async () => {
    db.execute
      .mockResolvedValueOnce([
        primaryRow({ urls: ['https://juanamolina.bandcamp.com/album/doga', 'https://discogs.com/release/123'] }),
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].urls).toEqual(['https://juanamolina.bandcamp.com/album/doga', 'https://discogs.com/release/123']);
  });

  it('raw-row mapper: a release with no links reads as [] (NULL array_agg), not null', async () => {
    db.execute.mockResolvedValueOnce([primaryRow({ urls: null })]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].urls).toEqual([]);
  });

  it('raw-row mapper: a NON-ROTATING release still carries its links (the persist behavior)', async () => {
    // rotation_bin null + no card = not currently rotating (a killed row is
    // likewise absent from the CURRENT_DATE-filtered view, so it reads the
    // same here). `card` is null, but `urls` is release-scoped and persists.
    db.execute
      .mockResolvedValueOnce([
        primaryRow({ rotation_bin: null, card_id: null, urls: ['https://open.spotify.com/album/xyz'] }),
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].card).toBeNull();
    expect(results[0].rotation_bin).toBeNull();
    expect(results[0].urls).toEqual(['https://open.spotify.com/album/xyz']);
  });

  it('cascade (track-title) mapper: rows carry [] — release detail is their populated surface', async () => {
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    mockRunCatalogTrackSearchCascade.mockResolvedValue([
      {
        id: 7100,
        add_date: '2024-01-15',
        album_title: 'Confield',
        artist_name: 'Autechre',
        code_letters: 'AU',
        code_number: 3,
        code_artist_number: 1,
        format_name: 'CD',
        genre_name: 'Electronic',
        label: 'Warp',
        label_id: 10,
        rotation_bin: null,
        card_id: null,
        card_bin: null,
        card_number: null,
        card_name: null,
        plays: 5,
        on_streaming: true,
        album_artist: null,
        artist_id: 501,
      },
    ]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].urls).toEqual([]);
  });
});
