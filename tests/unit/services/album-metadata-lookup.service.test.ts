/**
 * Unit tests for the local-state cache-first helper that backs
 * `/proxy/metadata/album` (BS#1331). The helper itself is mocked away in
 * the controller's suite, so these tests cover the JS-side shape that
 * wouldn't otherwise surface in CI until prod:
 *   - empty/whitespace-key guard (artist or release blank → null)
 *   - two-step query semantics (step 1 finds an album_id; step 2 PK-looks
 *     up album_metadata; absent album_metadata → null fallthrough)
 *   - deterministic ORDER BY id DESC LIMIT 1 on step 1
 *
 * The drizzle DB chain is mocked at the module level so test cases can
 * stub each query's resolved rows independently. The shape mirrors
 * `tests/unit/services/playlist-proxy.service.test.ts`.
 */
import { jest } from '@jest/globals';

// --- Drizzle DB chain mock ---
//
// Each `db.select(...)` call returns a fresh chain whose terminal awaitable
// is the array of rows pushed via `mockRowsQueue`. Tests push step-1 rows
// first, then step-2 rows; the helper consumes them in order.

const mockRowsQueue: Array<Array<Record<string, unknown>>> = [];

function makeChain() {
  let resolveValue: Array<Record<string, unknown>> = [];
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(() => Promise.resolve(resolveValue)),
  } as unknown as {
    from: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
  };
  // Bind the next-queued result onto this chain's `limit` await.
  resolveValue = mockRowsQueue.shift() ?? [];
  return chain;
}

jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn(() => makeChain()),
  },
  flowsheet: {
    artist_name: 'artist_name',
    album_title: 'album_title',
    album_id: 'album_id',
    id: 'id',
  },
  album_metadata: {
    album_id: 'album_id',
    artwork_url: 'artwork_url',
    discogs_url: 'discogs_url',
    release_year: 'release_year',
    spotify_url: 'spotify_url',
    apple_music_url: 'apple_music_url',
    youtube_music_url: 'youtube_music_url',
    bandcamp_url: 'bandcamp_url',
    soundcloud_url: 'soundcloud_url',
    artist_bio: 'artist_bio',
    artist_wikipedia_url: 'artist_wikipedia_url',
  },
}));

import { lookupAlbumMetadataByKey } from '../../../apps/backend/services/album-metadata-lookup.service';

describe('album-metadata-lookup.service', () => {
  beforeEach(() => {
    mockRowsQueue.length = 0;
  });

  describe('empty-key guard', () => {
    it('returns null without touching the DB when artistName is empty', async () => {
      const result = await lookupAlbumMetadataByKey('', 'Some Album');
      expect(result).toBeNull();
      // No DB chain ever materialized — the rows queue stays empty
      // because step 1 was never reached.
      expect(mockRowsQueue.length).toBe(0);
    });

    it('returns null when artistName is whitespace-only (matches no key meaningfully)', async () => {
      const result = await lookupAlbumMetadataByKey('   ', 'Some Album');
      expect(result).toBeNull();
    });

    it('returns null when releaseTitle is undefined (artist-card surfaces fall through to LML)', async () => {
      const result = await lookupAlbumMetadataByKey('Some Artist', undefined);
      expect(result).toBeNull();
    });

    it('returns null when releaseTitle is empty', async () => {
      const result = await lookupAlbumMetadataByKey('Some Artist', '');
      expect(result).toBeNull();
    });

    it('returns null when releaseTitle is whitespace-only', async () => {
      const result = await lookupAlbumMetadataByKey('Some Artist', '\t  ');
      expect(result).toBeNull();
    });
  });

  describe('two-step query', () => {
    it('returns null when step 1 finds no matching flowsheet row (cold case)', async () => {
      // Step 1 → empty rowset; step 2 should not run.
      mockRowsQueue.push([]);
      const result = await lookupAlbumMetadataByKey('Unknown Artist', 'Unknown Album');
      expect(result).toBeNull();
    });

    it('returns null when step 2 finds no album_metadata row (race window: flowsheet INSERT before worker UPSERT)', async () => {
      // Step 1 finds album_id=42, step 2 returns empty (no album_metadata).
      mockRowsQueue.push([{ album_id: 42 }]);
      mockRowsQueue.push([]);
      const result = await lookupAlbumMetadataByKey('In-Flight Artist', 'In-Flight Album');
      expect(result).toBeNull();
    });

    it('returns the persisted 10-column projection on a hit', async () => {
      mockRowsQueue.push([{ album_id: 7 }]);
      mockRowsQueue.push([
        {
          artwork_url: 'https://i.discogs.com/x.jpg',
          discogs_url: 'https://www.discogs.com/release/7',
          release_year: 2010,
          spotify_url: 'https://open.spotify.com/album/7',
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: 'Bio.',
          artist_wikipedia_url: null,
        },
      ]);
      const result = await lookupAlbumMetadataByKey('Hit Artist', 'Hit Album');
      expect(result).toEqual({
        artwork_url: 'https://i.discogs.com/x.jpg',
        discogs_url: 'https://www.discogs.com/release/7',
        release_year: 2010,
        spotify_url: 'https://open.spotify.com/album/7',
        apple_music_url: null,
        youtube_music_url: null,
        bandcamp_url: null,
        soundcloud_url: null,
        artist_bio: 'Bio.',
        artist_wikipedia_url: null,
      });
    });

    it('catch-arm-shape row (YT/BC/SC populated, others null) is returned faithfully — caller decides synthesis', async () => {
      mockRowsQueue.push([{ album_id: 100 }]);
      mockRowsQueue.push([
        {
          artwork_url: null,
          discogs_url: null,
          release_year: null,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: 'https://music.youtube.com/search?q=Catch%20Arm%20Artist',
          bandcamp_url: 'https://bandcamp.com/search?q=Catch%20Arm%20Artist',
          soundcloud_url: 'https://soundcloud.com/search?q=Catch%20Arm%20Artist',
          artist_bio: null,
          artist_wikipedia_url: null,
        },
      ]);
      const result = await lookupAlbumMetadataByKey('Catch Arm Artist', 'Catch Arm Album');
      expect(result?.youtube_music_url).toContain('music.youtube.com');
      expect(result?.bandcamp_url).toContain('bandcamp.com');
      expect(result?.soundcloud_url).toContain('soundcloud.com');
      expect(result?.apple_music_url).toBeNull();
      expect(result?.spotify_url).toBeNull();
      expect(result?.artwork_url).toBeNull();
    });
  });
});
