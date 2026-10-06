import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * Shared scaffold for the `searchLibrary` mapper tests: the `runCatalogTrackSearchCascade` mock, the Sentry span
 * mock, the request params, one full-width row fixture, and the per-test reset. Import this module BEFORE
 * `library-search.service` so its `jest.mock` calls register ahead of the service's own imports.
 */

export const mockRunCatalogTrackSearchCascade = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

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

import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';

export const PARAMS = {
  q: 'autechre',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

/** A raw `db.execute` row (snake_case, as `toAlbumSearchResultRow` reads it); doubles as a cascade `TaggedLibraryViewEntry`. */
export function libraryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7100,
    add_date: '2024-01-15',
    album_title: 'Confield',
    artist_name: 'Autechre',
    artist_id: 501,
    code_letters: 'AU',
    code_number: 3,
    code_artist_number: 1,
    code_comp_letter: null,
    code_volume_letters: null,
    format_name: 'CD',
    genre_name: 'Electronic',
    genre_id: 11,
    label: 'Warp',
    label_id: 10,
    rotation_bin: null,
    plays: 5,
    on_streaming: true,
    album_artist: null,
    artwork_url: null,
    discogs_unavailable: false,
    discogs_unavailable_note: null,
    last_discogs_recheck_at: null,
    ...overrides,
  };
}

/** The alias columns that turn a primary row into an alias-only hit (branch B). */
export const ALIAS_HIT = {
  alias_max_sim: 0.85,
  alias_matched_variant: 'Autecher',
  alias_matched_source: 'discogs_name_variation',
};

/** Resets the mocks and the alias flag before each test, and restores the flag afterwards. */
export function useSearchLibraryScaffold(): void {
  const originalFlag = process.env.CATALOG_SEARCH_ALIAS_ENABLED;

  beforeEach(() => {
    db.execute.mockReset();
    mockRunCatalogTrackSearchCascade.mockReset();
    mockRunCatalogTrackSearchCascade.mockResolvedValue([]);
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    else process.env.CATALOG_SEARCH_ALIAS_ENABLED = originalFlag;
    resetCatalogSearchAliasConfig();
  });
}
