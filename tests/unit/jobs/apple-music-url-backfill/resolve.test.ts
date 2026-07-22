/**
 * Unit tests for apple-music-url-backfill resolve.ts (BS#1631).
 *
 * Pins the write-side contract of the remediation:
 *
 *   1. `extractAppleMusicUrl` reads ONLY the top-1 result's artwork block
 *      and coerces absent / null / empty-string to null.
 *   2. `applyUpdate` writes ONLY `apple_music_url` (plus the `updated_at`
 *      bump on album_metadata; flowsheet's trigger owns its own bump) —
 *      never any other metadata column.
 *   3. Never-overwrite is enforced in the UPDATE's WHERE clause
 *      (`... AND apple_music_url IS NULL`), not just application logic:
 *      a raced non-null row matches 0 rows and reports 'skipped_non_null'.
 */
import { jest } from '@jest/globals';

import { db, album_metadata, flowsheet } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import { applyUpdate, extractAppleMusicUrl } from '../../../../jobs/apple-music-url-backfill/resolve';

const mockDb = db as unknown as {
  update: jest.Mock;
  insert: jest.Mock;
  _chain: {
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
};

const APPLE_URL = 'https://music.apple.com/us/album/on-your-own-love-again/950005510';

const matchedResponse: LookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: {
        release_id: 6543210,
        release_url: 'https://www.discogs.com/release/6543210',
        artwork_url: 'https://i.discogs.com/jessica-pratt.jpg',
        release_year: 2015,
        spotify_url: 'https://open.spotify.com/album/abc',
        apple_music_url: APPLE_URL,
        youtube_music_url: null,
        bandcamp_url: null,
        soundcloud_url: null,
      },
    },
  ],
  search_type: 'direct',
  song_not_found: false,
};

describe('extractAppleMusicUrl', () => {
  it('returns the top-1 artwork apple_music_url', () => {
    expect(extractAppleMusicUrl(matchedResponse)).toBe(APPLE_URL);
  });

  it('returns null when results are empty', () => {
    expect(extractAppleMusicUrl({ results: [], search_type: 'none', song_not_found: true })).toBeNull();
  });

  it('returns null when the top-1 result has no artwork block', () => {
    expect(
      extractAppleMusicUrl({ results: [{ library_item: { id: 1 }, artwork: null }], search_type: 'direct' })
    ).toBeNull();
  });

  it('returns null when apple_music_url is null or absent on the artwork block', () => {
    const nullUrl: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, apple_music_url: null },
        },
      ],
    };
    expect(extractAppleMusicUrl(nullUrl)).toBeNull();

    const absentUrl: LookupResponse = {
      ...matchedResponse,
      results: [{ library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'x' } }],
    };
    expect(extractAppleMusicUrl(absentUrl)).toBeNull();
  });

  it('coerces an empty-string URL to null (never write a blank into the column)', () => {
    const emptyUrl: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, apple_music_url: '' },
        },
      ],
    };
    expect(extractAppleMusicUrl(emptyUrl)).toBeNull();
  });

  it('ignores apple_music_url on non-top-1 results', () => {
    const secondHasUrl: LookupResponse = {
      ...matchedResponse,
      results: [
        { library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'x' } },
        { library_item: { id: 2 }, artwork: { ...matchedResponse.results[0].artwork! } },
      ],
    };
    expect(extractAppleMusicUrl(secondHasUrl)).toBeNull();
  });
});

describe('applyUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: 42 }]);
  });

  it('flowsheet: sets ONLY apple_music_url (trigger owns updated_at) and returns resolved', async () => {
    const outcome = await applyUpdate('flowsheet', 42, APPLE_URL);

    expect(outcome).toBe('resolved');
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toEqual({ apple_music_url: APPLE_URL });
  });

  it('album_metadata: sets apple_music_url plus the updated_at bump and nothing else', async () => {
    const outcome = await applyUpdate('album_metadata', 7, APPLE_URL);

    expect(outcome).toBe('resolved');
    expect(mockDb.update).toHaveBeenCalledWith(album_metadata);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.apple_music_url).toBe(APPLE_URL);
    expect('updated_at' in setArgs).toBe(true);
    expect(Object.keys(setArgs).sort()).toEqual(['apple_music_url', 'updated_at']);
  });

  it.each([
    { target: 'album_metadata' as const, idColumn: 'album_id' },
    { target: 'flowsheet' as const, idColumn: 'id' },
  ])(
    '$target: WHERE is exactly id-equality AND apple_music_url IS NULL (the never-overwrite guard lives in SQL)',
    async ({ target, idColumn }) => {
      await applyUpdate(target, 42, APPLE_URL);

      // Exact shape from tests/__mocks__/drizzle-orm.ts (and/eq/isNull) —
      // a mutation to e.g. eq(apple_music_url, url) must fail this, not
      // slip past a loose substring match.
      const whereCall = mockDb._chain.where.mock.calls[0]?.[0];
      expect(whereCall).toEqual({
        and: [{ eq: [idColumn, 42] }, { isNull: 'apple_music_url' }],
      });
    }
  );

  it.each(['album_metadata', 'flowsheet'] as const)(
    '%s: returns skipped_non_null when the UPDATE matches 0 rows (URL appeared since the SELECT)',
    async (target) => {
      mockDb._chain.returning.mockResolvedValue([]);
      const outcome = await applyUpdate(target, 42, APPLE_URL);
      expect(outcome).toBe('skipped_non_null');
    }
  );

  it('never touches any other table (no inserts, single update)', async () => {
    await applyUpdate('flowsheet', 42, APPLE_URL);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});
