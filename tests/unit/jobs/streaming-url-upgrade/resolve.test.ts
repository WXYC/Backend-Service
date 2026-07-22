/**
 * Unit tests for streaming-url-upgrade resolve.ts (BS#1672).
 *
 * Pins the write-side contract of the upgrade pass:
 *
 *   1. `isSearchShaped` recognizes ONLY a service's own search-URL prefix
 *      — the shape predicate that decides which columns are upgradeable.
 *   2. `extractStreamingUrls` reads ONLY the top-1 result's artwork block,
 *      returns the verified URL per service, and coerces absent / null /
 *      empty-string / (defensively) a still-search-shaped value to null so
 *      the job never overwrites a search URL with another search URL.
 *   3. `applyUpgrade` writes ONLY the one target column (plus the
 *      `updated_at` bump on album_metadata; flowsheet's trigger owns its
 *      own bump) — never any other metadata column.
 *   4. Never-downgrade is enforced in the UPDATE's WHERE clause
 *      (`... AND <column> LIKE '<search-prefix>%'`), not just application
 *      logic: a row whose column was verified between the SELECT and this
 *      UPDATE matches 0 rows and reports 'skipped_not_search'.
 */
import { jest } from '@jest/globals';

import { db, album_metadata, flowsheet } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import { applyUpgrade, extractStreamingUrls, isSearchShaped } from '../../../../jobs/streaming-url-upgrade/resolve';

const mockDb = db as unknown as {
  update: jest.Mock;
  insert: jest.Mock;
  _chain: {
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
};

const SPOTIFY_SEARCH = 'https://open.spotify.com/search/jessica%20pratt';
const SPOTIFY_VERIFIED = 'https://open.spotify.com/album/6xB8dRegF2Cglc7lqZWmZ4';
const BANDCAMP_SEARCH = 'https://bandcamp.com/search?q=jessica%20pratt';
const BANDCAMP_VERIFIED = 'https://jessicapratt.bandcamp.com/album/on-your-own-love-again';

const artworkWith = (overrides: Record<string, unknown>) => ({
  release_id: 6543210,
  release_url: 'https://www.discogs.com/release/6543210',
  artwork_url: 'https://i.discogs.com/jessica-pratt.jpg',
  release_year: 2015,
  spotify_url: SPOTIFY_VERIFIED,
  apple_music_url: null,
  youtube_music_url: null,
  bandcamp_url: BANDCAMP_VERIFIED,
  soundcloud_url: null,
  ...overrides,
});

const responseWith = (overrides: Record<string, unknown>): LookupResponse => ({
  results: [{ library_item: { id: 1 }, artwork: artworkWith(overrides) }],
  search_type: 'direct',
  song_not_found: false,
});

describe('isSearchShaped', () => {
  it('recognizes each service by its own search-URL prefix', () => {
    expect(isSearchShaped('spotify', SPOTIFY_SEARCH)).toBe(true);
    expect(isSearchShaped('bandcamp', BANDCAMP_SEARCH)).toBe(true);
  });

  it('is false for a verified (non-search) URL', () => {
    expect(isSearchShaped('spotify', SPOTIFY_VERIFIED)).toBe(false);
    expect(isSearchShaped('bandcamp', BANDCAMP_VERIFIED)).toBe(false);
  });

  it('is false for null / undefined / empty', () => {
    expect(isSearchShaped('spotify', null)).toBe(false);
    expect(isSearchShaped('spotify', undefined)).toBe(false);
    expect(isSearchShaped('spotify', '')).toBe(false);
  });

  it('does not cross services: a spotify search URL is not bandcamp-search-shaped', () => {
    expect(isSearchShaped('bandcamp', SPOTIFY_SEARCH)).toBe(false);
    expect(isSearchShaped('spotify', BANDCAMP_SEARCH)).toBe(false);
  });
});

describe('extractStreamingUrls', () => {
  it('returns the top-1 verified URL per service', () => {
    expect(extractStreamingUrls(responseWith({}))).toEqual({
      spotify: SPOTIFY_VERIFIED,
      bandcamp: BANDCAMP_VERIFIED,
    });
  });

  it('returns nulls when results are empty', () => {
    expect(
      extractStreamingUrls({ results: [], search_type: 'none', song_not_found: true } as unknown as LookupResponse)
    ).toEqual({ spotify: null, bandcamp: null });
  });

  it('returns nulls when the top-1 result has no artwork block', () => {
    expect(
      extractStreamingUrls({
        results: [{ library_item: { id: 1 }, artwork: null }],
        search_type: 'direct',
      } as unknown as LookupResponse)
    ).toEqual({ spotify: null, bandcamp: null });
  });

  it('nulls a service whose URL is null or absent', () => {
    expect(extractStreamingUrls(responseWith({ spotify_url: null }))).toEqual({
      spotify: null,
      bandcamp: BANDCAMP_VERIFIED,
    });
  });

  it('coerces an empty-string URL to null', () => {
    expect(extractStreamingUrls(responseWith({ bandcamp_url: '' }))).toEqual({
      spotify: SPOTIFY_VERIFIED,
      bandcamp: null,
    });
  });

  it('never returns a still-search-shaped URL (no search→search upgrade)', () => {
    expect(extractStreamingUrls(responseWith({ spotify_url: SPOTIFY_SEARCH, bandcamp_url: BANDCAMP_SEARCH }))).toEqual({
      spotify: null,
      bandcamp: null,
    });
  });

  it('ignores URLs on non-top-1 results', () => {
    const secondHasUrl = {
      results: [
        { library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'x' } },
        { library_item: { id: 2 }, artwork: artworkWith({}) },
      ],
      search_type: 'direct',
    } as unknown as LookupResponse;
    expect(extractStreamingUrls(secondHasUrl)).toEqual({ spotify: null, bandcamp: null });
  });
});

describe('applyUpgrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: 42 }]);
  });

  it('flowsheet spotify: sets ONLY spotify_url (trigger owns updated_at) and returns upgraded', async () => {
    const outcome = await applyUpgrade('flowsheet', 42, 'spotify', SPOTIFY_VERIFIED);

    expect(outcome).toBe('upgraded');
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toEqual({ spotify_url: SPOTIFY_VERIFIED });
  });

  it('flowsheet bandcamp: sets ONLY bandcamp_url', async () => {
    await applyUpgrade('flowsheet', 42, 'bandcamp', BANDCAMP_VERIFIED);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toEqual({ bandcamp_url: BANDCAMP_VERIFIED });
  });

  it('album_metadata spotify: sets spotify_url plus the updated_at bump and nothing else', async () => {
    const outcome = await applyUpgrade('album_metadata', 7, 'spotify', SPOTIFY_VERIFIED);

    expect(outcome).toBe('upgraded');
    expect(mockDb.update).toHaveBeenCalledWith(album_metadata);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.spotify_url).toBe(SPOTIFY_VERIFIED);
    expect(Object.keys(setArgs).sort()).toEqual(['spotify_url', 'updated_at']);
  });

  it('album_metadata bandcamp: sets bandcamp_url plus updated_at', async () => {
    await applyUpgrade('album_metadata', 7, 'bandcamp', BANDCAMP_VERIFIED);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.bandcamp_url).toBe(BANDCAMP_VERIFIED);
    expect(Object.keys(setArgs).sort()).toEqual(['bandcamp_url', 'updated_at']);
  });

  it.each([
    {
      target: 'album_metadata' as const,
      idColumn: 'album_id',
      service: 'spotify' as const,
      column: 'spotify_url',
      prefix: 'https://open.spotify.com/search/%',
    },
    {
      target: 'flowsheet' as const,
      idColumn: 'id',
      service: 'spotify' as const,
      column: 'spotify_url',
      prefix: 'https://open.spotify.com/search/%',
    },
    {
      target: 'flowsheet' as const,
      idColumn: 'id',
      service: 'bandcamp' as const,
      column: 'bandcamp_url',
      prefix: 'https://bandcamp.com/search?q=%',
    },
  ])(
    '$target $service: WHERE is id-equality AND <column> LIKE <search-prefix> (the never-downgrade guard lives in SQL)',
    async ({ target, idColumn, service, column, prefix }) => {
      await applyUpgrade(target, 42, service, 'https://verified.example/x');

      const whereCall = mockDb._chain.where.mock.calls[0]?.[0];
      expect(whereCall).toEqual({
        and: [{ eq: [idColumn, 42] }, { like: [column, prefix] }],
      });
    }
  );

  it.each(['album_metadata', 'flowsheet'] as const)(
    '%s: returns skipped_not_search when the UPDATE matches 0 rows (column was verified since the SELECT)',
    async (target) => {
      mockDb._chain.returning.mockResolvedValue([]);
      const outcome = await applyUpgrade(target, 42, 'spotify', SPOTIFY_VERIFIED);
      expect(outcome).toBe('skipped_not_search');
    }
  );

  it('never touches any other table (no inserts, single update)', async () => {
    await applyUpgrade('flowsheet', 42, 'spotify', SPOTIFY_VERIFIED);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});
