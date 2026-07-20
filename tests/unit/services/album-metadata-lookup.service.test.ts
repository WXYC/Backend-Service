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
// first, then step-2 rows; the helper consumes them in order. The mock's
// .from/.where/.orderBy/.limit are also captured on `chainSpy` so tests
// can pin the SQL contract (`ORDER BY` on step 1, `eq()` on step 2).

const mockRowsQueue: Array<Array<Record<string, unknown>>> = [];

const mockSelect = jest.fn();
const chainSpy = {
  from: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
};

function makeChain() {
  let resolveValue: Array<Record<string, unknown>> = [];
  const chain = {
    from: (...args: unknown[]) => {
      chainSpy.from(...args);
      return chain;
    },
    where: (...args: unknown[]) => {
      chainSpy.where(...args);
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      chainSpy.orderBy(...args);
      return chain;
    },
    limit: (...args: unknown[]) => {
      chainSpy.limit(...args);
      return Promise.resolve(resolveValue);
    },
  };
  resolveValue = mockRowsQueue.shift() ?? [];
  return chain;
}

mockSelect.mockImplementation(() => makeChain());

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
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
    // LML-only enrichment columns (BS#1336).
    discogs_artist_id: 'discogs_artist_id',
    label: 'label',
    full_release_date: 'full_release_date',
    genres: 'genres',
    styles: 'styles',
    tracklist: 'tracklist',
    artist_image_url: 'artist_image_url',
    bio_tokens: 'bio_tokens',
  },
  album_critic_reviews: {
    id: 'id',
    album_id: 'album_id',
    source: 'source',
    source_url: 'source_url',
    snippet: 'snippet',
    author: 'author',
    published_at: 'published_at',
    rating: 'rating',
  },
}));

import {
  lookupAlbumMetadataByKey,
  lookupCriticReviewsByAlbumKey,
} from '../../../apps/backend/services/album-metadata-lookup.service';

describe('album-metadata-lookup.service', () => {
  beforeEach(() => {
    mockRowsQueue.length = 0;
    mockSelect.mockClear();
    chainSpy.from.mockClear();
    chainSpy.where.mockClear();
    chainSpy.orderBy.mockClear();
    chainSpy.limit.mockClear();
  });

  describe('empty-key guard', () => {
    // Pin the contract that the guard prevents *any* DB call: a regression
    // that removes the guard would shift these from `select=0` to `select=1`,
    // letting `'-'`-keyed requests reach the partial index.
    it('returns null without touching the DB when artistName is empty', async () => {
      const result = await lookupAlbumMetadataByKey('', 'Some Album');
      expect(result).toBeNull();
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns null when artistName is whitespace-only (matches no key meaningfully)', async () => {
      const result = await lookupAlbumMetadataByKey('   ', 'Some Album');
      expect(result).toBeNull();
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns null when releaseTitle is undefined (artist-card surfaces fall through to LML)', async () => {
      const result = await lookupAlbumMetadataByKey('Some Artist', undefined);
      expect(result).toBeNull();
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns null when releaseTitle is empty', async () => {
      const result = await lookupAlbumMetadataByKey('Some Artist', '');
      expect(result).toBeNull();
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns null when releaseTitle is whitespace-only', async () => {
      const result = await lookupAlbumMetadataByKey('Some Artist', '\t  ');
      expect(result).toBeNull();
      expect(mockSelect).not.toHaveBeenCalled();
    });
  });

  describe('two-step query', () => {
    it('returns null when step 1 finds no matching flowsheet row (cold case) — step 2 short-circuits', async () => {
      // Step 1 → empty rowset; pin that step 2 is skipped via select call count.
      // A regression that removed the `albumId === undefined || albumId === null
      // → return null` guard would shift this to `select=2`.
      mockRowsQueue.push([]);
      const result = await lookupAlbumMetadataByKey('Unknown Artist', 'Unknown Album');
      expect(result).toBeNull();
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('returns null when step 2 finds no album_metadata row (race window: flowsheet INSERT before worker UPSERT)', async () => {
      // Step 1 finds album_id=42, step 2 returns empty (no album_metadata).
      mockRowsQueue.push([{ album_id: 42 }]);
      mockRowsQueue.push([]);
      const result = await lookupAlbumMetadataByKey('In-Flight Artist', 'In-Flight Album');
      expect(result).toBeNull();
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it('issues ORDER BY on step 1 for deterministic row-pick on multi-album_id keys', async () => {
      // Pin BS#1331 round-2 review fix: dropping the ORDER BY here would
      // re-introduce iOS-visible flapping between distinct album_metadata
      // payloads when a lookup key resolves to multiple album_ids
      // (V/A multi-format, dual-pressings, librarian duplicates — empirically
      // present in the live `album_id` corpus).
      mockRowsQueue.push([{ album_id: 1 }]);
      mockRowsQueue.push([
        {
          artwork_url: null,
          discogs_url: null,
          release_year: null,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
        },
      ]);
      await lookupAlbumMetadataByKey('Multi Artist', 'Same Title Different Pressings');
      // Step 1 uses orderBy; step 2 (PK lookup) does not.
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(1);
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

    it('returns the 8 LML-only enrichment fields on a hit (BS#1336)', async () => {
      mockRowsQueue.push([{ album_id: 7 }]);
      mockRowsQueue.push([
        {
          artwork_url: 'https://i.discogs.com/x.jpg',
          discogs_url: 'https://www.discogs.com/release/7',
          release_year: 2022,
          spotify_url: null,
          apple_music_url: null,
          youtube_music_url: null,
          bandcamp_url: null,
          soundcloud_url: null,
          artist_bio: null,
          artist_wikipedia_url: null,
          discogs_artist_id: 3840,
          label: 'Sonamos',
          full_release_date: '2022-09-30',
          genres: ['Rock'],
          styles: ['Folk', 'Indie Rock'],
          tracklist: [{ position: '1', title: 'la paradoja', duration: '4:12' }],
          artist_image_url: 'https://i.discogs.com/artist/juana.jpg',
          bio_tokens: [{ type: 'plainText', text: 'Argentine musician' }],
        },
      ]);
      const result = await lookupAlbumMetadataByKey('Juana Molina', 'DOGA');
      expect(result?.discogs_artist_id).toBe(3840);
      expect(result?.label).toBe('Sonamos');
      expect(result?.full_release_date).toBe('2022-09-30');
      expect(result?.genres).toEqual(['Rock']);
      expect(result?.styles).toEqual(['Folk', 'Indie Rock']);
      expect(result?.tracklist).toEqual([{ position: '1', title: 'la paradoja', duration: '4:12' }]);
      expect(result?.artist_image_url).toBe('https://i.discogs.com/artist/juana.jpg');
      expect(result?.bio_tokens).toEqual([{ type: 'plainText', text: 'Argentine musician' }]);
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

  describe('lookupCriticReviewsByAlbumKey', () => {
    // Shares Step-1 (resolveLinkedAlbumId) with the metadata read, so the
    // same empty-key + cold-case guards apply. Then it projects
    // album_critic_reviews rows onto the CriticReviewItem wire shape (ADR
    // 0012): url ← source_url, publishedDate ← published_at, optional fields
    // omitted when null.

    it('returns [] without touching the DB when artistName is empty (shared guard)', async () => {
      const result = await lookupCriticReviewsByAlbumKey('', 'Some Album');
      expect(result).toEqual([]);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns [] without touching the DB when releaseTitle is blank (shared guard)', async () => {
      const result = await lookupCriticReviewsByAlbumKey('Some Artist', '  ');
      expect(result).toEqual([]);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns [] when the key resolves to no linked album (cold case) — reviews query short-circuits', async () => {
      // Step 1 → empty rowset; pin that step 2 is skipped via select call count.
      mockRowsQueue.push([]);
      const result = await lookupCriticReviewsByAlbumKey('Unknown Artist', 'Unknown Album');
      expect(result).toEqual([]);
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('returns [] when the linked album has no seeded snippets', async () => {
      mockRowsQueue.push([{ album_id: 42 }]);
      mockRowsQueue.push([]);
      const result = await lookupCriticReviewsByAlbumKey('Seeded Artist', 'Unseeded Album');
      expect(result).toEqual([]);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it('projects a full row onto the wire shape (url ← source_url, publishedDate ← published_at)', async () => {
      mockRowsQueue.push([{ album_id: 7 }]);
      mockRowsQueue.push([
        {
          source: 'The Quietus',
          source_url: 'https://thequietus.com/articles/juana-molina-doga',
          snippet: 'A record that dissolves the line between song and texture.',
          author: 'A. Critic',
          published_at: '2024-03-15',
          rating: '8.0',
        },
      ]);
      const result = await lookupCriticReviewsByAlbumKey('Juana Molina', 'DOGA');
      expect(result).toEqual([
        {
          source: 'The Quietus',
          url: 'https://thequietus.com/articles/juana-molina-doga',
          snippet: 'A record that dissolves the line between song and texture.',
          author: 'A. Critic',
          publishedDate: '2024-03-15',
          rating: '8.0',
        },
      ]);
    });

    it('omits optional fields (author/publishedDate/rating) when null so decodeIfPresent stays compatible', async () => {
      mockRowsQueue.push([{ album_id: 7 }]);
      mockRowsQueue.push([
        {
          source: 'Pitchfork',
          source_url: 'https://pitchfork.com/reviews/albums/example',
          snippet: 'The most quietly radical thing she has made.',
          author: null,
          published_at: null,
          rating: null,
        },
      ]);
      const result = await lookupCriticReviewsByAlbumKey('Jessica Pratt', 'On Your Own Love Again');
      expect(result).toEqual([
        {
          source: 'Pitchfork',
          url: 'https://pitchfork.com/reviews/albums/example',
          snippet: 'The most quietly radical thing she has made.',
        },
      ]);
      // No undefined optional keys leaked onto the item.
      expect(Object.keys(result[0])).toEqual(['source', 'url', 'snippet']);
    });

    it('preserves row order and returns every projected snippet on a multi-review hit', async () => {
      mockRowsQueue.push([{ album_id: 9 }]);
      mockRowsQueue.push([
        {
          source: 'A',
          source_url: 'https://a/1',
          snippet: 'first',
          author: null,
          published_at: '2024-05-01',
          rating: null,
        },
        {
          source: 'B',
          source_url: 'https://b/2',
          snippet: 'second',
          author: null,
          published_at: '2023-01-01',
          rating: null,
        },
      ]);
      const result = await lookupCriticReviewsByAlbumKey('Multi Artist', 'Reviewed Album');
      expect(result.map((r) => r.source)).toEqual(['A', 'B']);
      // Step 1 (resolveLinkedAlbumId) and step 2 (reviews) both order for
      // determinism — pin that the reviews query carries an ORDER BY (the
      // newest-first + stable-tiebreak contract) rather than relying on
      // insertion order.
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(2);
    });
  });
});
