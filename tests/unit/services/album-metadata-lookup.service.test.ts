/**
 * Unit tests for the local-state cache-first helpers that back
 * `/proxy/metadata/album` (BS#1331, album-critic-reviews slice ADR 0012).
 * The controller resolves the `album_id` once via `resolveLinkedAlbumId` and
 * feeds it to `lookupAlbumMetadataById` and `lookupCriticReviewsByAlbumId`;
 * all three are mocked away in the controller's suite, so these tests cover
 * the JS-side shape that wouldn't otherwise surface in CI until prod:
 *   - `resolveLinkedAlbumId`: empty/whitespace-key guard (artist or release
 *     blank → null, no DB), cold-case (no match → null), deterministic
 *     `ORDER BY id DESC LIMIT 1` on multi-album_id keys
 *   - `lookupAlbumMetadataById`: PK-lookup projection; absent row → null
 *     fallthrough; no ORDER BY (it's a PK read, not a pick)
 *   - `lookupCriticReviewsByAlbumId`: newest-first ORDER BY, wire-shape
 *     projection (url ← source_url, publishedDate ← published_at, null
 *     optionals omitted)
 *
 * The drizzle DB chain is mocked at the module level so test cases can stub
 * each query's resolved rows independently. Each by-id helper issues exactly
 * one `db.select(...)`, so a test pushes one rowset per call. The shape
 * mirrors `tests/unit/services/playlist-proxy.service.test.ts`.
 */
import { jest } from '@jest/globals';

// --- Drizzle DB chain mock ---
//
// Each `db.select(...)` call returns a fresh chain whose terminal awaitable
// is the next array of rows pushed via `mockRowsQueue`. The mock's
// .from/.where/.orderBy/.limit are also captured on `chainSpy` so tests can
// pin the SQL contract (`ORDER BY` presence per query).

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
  resolveLinkedAlbumId,
  lookupAlbumMetadataById,
  lookupCriticReviewsByAlbumId,
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

  describe('resolveLinkedAlbumId', () => {
    describe('empty-key guard', () => {
      // Pin the contract that the guard prevents *any* DB call: a regression
      // that removes the guard would shift these from `select=0` to `select=1`,
      // letting `'-'`-keyed requests reach the partial index and resolve an
      // arbitrary album_id.
      it('returns null without touching the DB when artistName is empty', async () => {
        expect(await resolveLinkedAlbumId('', 'Some Album')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when artistName is whitespace-only', async () => {
        expect(await resolveLinkedAlbumId('   ', 'Some Album')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is undefined (artist-card surfaces fall through to LML)', async () => {
        expect(await resolveLinkedAlbumId('Some Artist', undefined)).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is empty', async () => {
        expect(await resolveLinkedAlbumId('Some Artist', '')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is whitespace-only', async () => {
        expect(await resolveLinkedAlbumId('Some Artist', '\t  ')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });
    });

    it('returns null on the cold case (no matching album_id-bearing flowsheet row)', async () => {
      mockRowsQueue.push([]);
      expect(await resolveLinkedAlbumId('Unknown Artist', 'Unknown Album')).toBeNull();
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('returns the album_id and issues ORDER BY for a deterministic row-pick on multi-album_id keys', async () => {
      // Pin BS#1331 round-2 review fix: dropping the ORDER BY here would
      // re-introduce iOS-visible flapping between distinct album_metadata
      // payloads when a lookup key resolves to multiple album_ids
      // (V/A multi-format, dual-pressings, librarian duplicates — empirically
      // present in the live `album_id` corpus).
      mockRowsQueue.push([{ album_id: 42 }]);
      const albumId = await resolveLinkedAlbumId('Multi Artist', 'Same Title Different Pressings');
      expect(albumId).toBe(42);
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('lookupAlbumMetadataById', () => {
    it('returns null when no album_metadata row exists (race window: flowsheet INSERT before worker UPSERT)', async () => {
      mockRowsQueue.push([]);
      const result = await lookupAlbumMetadataById(42);
      expect(result).toBeNull();
      // A single PK read — no ORDER BY (the pick already happened in resolve).
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(chainSpy.orderBy).not.toHaveBeenCalled();
    });

    it('returns the persisted 10-column projection on a hit', async () => {
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
      const result = await lookupAlbumMetadataById(7);
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
      const result = await lookupAlbumMetadataById(7);
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
      const result = await lookupAlbumMetadataById(100);
      expect(result?.youtube_music_url).toContain('music.youtube.com');
      expect(result?.bandcamp_url).toContain('bandcamp.com');
      expect(result?.soundcloud_url).toContain('soundcloud.com');
      expect(result?.apple_music_url).toBeNull();
      expect(result?.spotify_url).toBeNull();
      expect(result?.artwork_url).toBeNull();
    });
  });

  describe('lookupCriticReviewsByAlbumId', () => {
    // Projects album_critic_reviews rows onto the CriticReviewItem wire shape
    // (ADR 0012): url ← source_url, publishedDate ← published_at, optional
    // fields omitted when null.

    it('returns [] when the linked album has no seeded snippets', async () => {
      mockRowsQueue.push([]);
      const result = await lookupCriticReviewsByAlbumId(42);
      expect(result).toEqual([]);
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('projects a full row onto the wire shape (url ← source_url, publishedDate ← published_at)', async () => {
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
      const result = await lookupCriticReviewsByAlbumId(7);
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
      const result = await lookupCriticReviewsByAlbumId(7);
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

    it('preserves row order and pins the newest-first ORDER BY on a multi-review hit', async () => {
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
      const result = await lookupCriticReviewsByAlbumId(9);
      expect(result.map((r) => r.source)).toEqual(['A', 'B']);
      // Pin that the reviews query carries an ORDER BY (the newest-first +
      // stable-tiebreak contract) rather than relying on insertion order.
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(1);
    });
  });
});
