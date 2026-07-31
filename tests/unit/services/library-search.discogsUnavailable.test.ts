import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

/**
 * BS#1895 (Not-on-Discogs epic #1280 sub-issue 5): the primary catalog-search
 * SELECT (library-search.service.ts, reading `library_artist_view` — the
 * `GET /library/query` read path, distinct from `library.service.ts`'s
 * LIBRARY_VIEW_PROJECTION join used by `GET /library`) must carry the MD-set
 * discogs_unavailable flag through to the wire, camelCased and with the
 * source columns stripped, matching the album-detail / GET-by-id surfaces.
 *
 * The cascade fallback (runCatalogTrackSearchCascade) is exercised in
 * library-search.missing-cascade.test.ts and other cascade-focused suites;
 * this file pins the primary `db.execute` row -> AlbumSearchResultRow
 * projection (`toAlbumSearchResultRow`) exclusively, so it doesn't need the
 * cascade mock.
 */

jest.mock('../../../apps/backend/services/library.service', () => ({
  runCatalogTrackSearchCascade: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
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

const PARAMS = {
  q: 'autechre',
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

// Raw `db.execute` row shape (snake_case, as `toAlbumSearchResultRow` reads it).
function primaryRow(overrides: Record<string, unknown> = {}) {
  return {
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
    plays: 5,
    on_streaming: true,
    album_artist: null,
    discogs_unavailable: false,
    discogs_unavailable_note: null,
    last_discogs_recheck_at: null,
    ...overrides,
  };
}

describe('searchLibrary primary path: discogsUnavailable serialization (BS#1895)', () => {
  beforeEach(() => {
    db.execute.mockReset();
  });

  it('serializes discogsUnavailable: true with its note for a flagged row', async () => {
    db.execute
      .mockResolvedValueOnce([
        primaryRow({ discogs_unavailable: true, discogs_unavailable_note: 'Embargoed promo pressing' }),
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0].discogsUnavailable).toBe(true);
    expect(results[0].discogsUnavailableNote).toBe('Embargoed promo pressing');
  });

  it('serializes discogsUnavailable: false (not omitted) for an unflagged row', async () => {
    db.execute.mockResolvedValueOnce([primaryRow()]).mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('discogsUnavailable', false);
    expect(results[0].discogsUnavailableNote).toBeNull();
  });

  it('passes lastDiscogsRecheckAt through when the recheck cron has stamped it', async () => {
    const recheckedAt = '2026-07-20T04:00:00.000Z';
    db.execute
      .mockResolvedValueOnce([primaryRow({ last_discogs_recheck_at: recheckedAt })])
      .mockResolvedValueOnce([{ total: 1 }]);

    const { results } = await searchLibrary(PARAMS);

    expect(results[0].lastDiscogsRecheckAt).toBe(recheckedAt);
  });
});
