/**
 * Unit tests for the local-state cache-first helpers that back
 * `/proxy/metadata/album` (BS#1331, album-critic-reviews slice ADR 0012).
 * The controller resolves the `album_id` once via `resolveLinkedAlbumId` and
 * feeds it to `lookupAlbumMetadataById` and `lookupCriticReviewsByAlbumId`;
 * all three are mocked away in the controller's suite, so these tests cover
 * the JS-side shape that wouldn't otherwise surface in CI until prod:
 *   - `lookupAlbumMetadataById`: PK-lookup projection; absent row → null
 *     fallthrough; no ORDER BY (it's a PK read, not a pick)
 *   - `lookupCriticReviewsByAlbumId`: newest-first ORDER BY, wire-shape
 *     projection (url ← source_url, publishedDate ← published_at, null
 *     optionals omitted)
 *
 * `resolveLinkedAlbumId`'s own tests moved to
 * `tests/unit/database/album-resolve.test.ts` (BS#1829): its implementation
 * now lives in `@wxyc/database` (`shared/database/src/album-resolve.ts`),
 * and this file's whole-package `jest.mock('@wxyc/database', ...)` below
 * can't exercise it — the mock factory doesn't (and can't cheaply) include
 * a working real implementation, so the service's thin re-export of it would
 * resolve to `undefined` under this mock. This file still imports it (via
 * the re-export shim) only insofar as `lookupAlbumMetadataById` /
 * `lookupCriticReviewsByAlbumId` don't call it directly — they don't.
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
    // The batched critic-reviews query (lookupCriticReviewsByAlbumIds) has no
    // terminal `.limit(...)` — it caps per-album in JS — so the chain itself
    // must be awaitable at the `.orderBy(...)` step, mirroring the real
    // drizzle query builder (every step is thenable, not just the one after
    // an explicit `.limit()`).
    then: (resolve: (value: Array<Record<string, unknown>>) => void, reject?: (reason?: unknown) => void) =>
      Promise.resolve(resolveValue).then(resolve, reject),
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
  // Consented DJ Google-Form reviews (ADR 0011). The PII-internal columns
  // (`reviewer_raw`, `social_consent_raw`) are declared here DELIBERATELY,
  // even though `lookupWxycReviewsByAlbumId` must never select them: the
  // PII-barrier test asserts they are absent from the projection, and that
  // assertion is only meaningful if they were reachable in the first place.
  // A mock that omitted them would make the barrier test pass vacuously.
  album_review_submissions: {
    id: 'id',
    album_id: 'album_id',
    review: 'review',
    artist_blurb: 'artist_blurb',
    recommended_tracks: 'recommended_tracks',
    buzzwords: 'buzzwords',
    social_consent: 'social_consent',
    submitted_at: 'submitted_at',
    reviewer_raw: 'reviewer_raw',
    social_consent_raw: 'social_consent_raw',
  },
}));

import {
  lookupAlbumMetadataById,
  lookupCriticReviewsByAlbumId,
  lookupCriticReviewsByAlbumIds,
  lookupWxycReviewsByAlbumId,
} from '../../../apps/backend/services/album-metadata-lookup.service';
import { renderSql } from '../../utils/render-sql';

describe('album-metadata-lookup.service', () => {
  beforeEach(() => {
    mockRowsQueue.length = 0;
    mockSelect.mockClear();
    chainSpy.from.mockClear();
    chainSpy.where.mockClear();
    chainSpy.orderBy.mockClear();
    chainSpy.limit.mockClear();
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

  describe('lookupCriticReviewsByAlbumIds (batched, BS#1870)', () => {
    // Batched sibling backing flowsheet feed-assembly's attachCriticReviews:
    // one query for a whole page's album_ids, grouped + capped in JS, reusing
    // the same wire projection as the single-album lookup above.

    it('returns an empty map and never touches the DB when albumIds is empty', async () => {
      const result = await lookupCriticReviewsByAlbumIds([]);
      expect(result).toEqual(new Map());
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns an empty map when no rows match any requested album_id', async () => {
      mockRowsQueue.push([]);
      const result = await lookupCriticReviewsByAlbumIds([42, 99]);
      expect(result).toEqual(new Map());
      expect(mockSelect).toHaveBeenCalledTimes(1);
      // Single indexed query for the whole batch — the no-N+1 guarantee.
      expect(chainSpy.where).toHaveBeenCalledTimes(1);
    });

    it('groups rows by album_id and projects each onto the wire shape', async () => {
      mockRowsQueue.push([
        {
          album_id: 501,
          source: 'The Quietus',
          source_url: 'https://thequietus.com/articles/juana-molina-doga',
          snippet: 'A record that dissolves the line between song and texture.',
          author: 'A. Critic',
          published_at: '2024-03-15',
          rating: '8.0',
        },
        {
          album_id: 777,
          source: 'Pitchfork',
          source_url: 'https://pitchfork.com/reviews/albums/example',
          snippet: 'The most quietly radical thing she has made.',
          author: null,
          published_at: null,
          rating: null,
        },
      ]);
      const result = await lookupCriticReviewsByAlbumIds([501, 777]);

      expect(result.get(501)).toEqual([
        {
          source: 'The Quietus',
          url: 'https://thequietus.com/articles/juana-molina-doga',
          snippet: 'A record that dissolves the line between song and texture.',
          author: 'A. Critic',
          publishedDate: '2024-03-15',
          rating: '8.0',
        },
      ]);
      expect(result.get(777)).toEqual([
        {
          source: 'Pitchfork',
          url: 'https://pitchfork.com/reviews/albums/example',
          snippet: 'The most quietly radical thing she has made.',
        },
      ]);
      // An album with no matching rows is absent from the map entirely (not
      // present with an empty array) — the caller treats the two identically.
      expect(result.has(999)).toBe(false);
    });

    it('caps each album at CRITIC_REVIEWS_LIMIT (5), keeping the newest-first rows', async () => {
      // Rows arrive pre-ordered by the query's ORDER BY (album_id, then
      // published_at DESC NULLS LAST, id DESC) — six rows for one album, the
      // 6th (oldest) must be dropped by the per-bucket cap.
      const rows = Array.from({ length: 6 }, (_, i) => ({
        album_id: 501,
        source: `Source ${i}`,
        source_url: `https://example.com/${i}`,
        snippet: `Snippet ${i}`,
        author: null,
        published_at: `2024-01-${String(10 - i).padStart(2, '0')}`, // descending
        rating: null,
      }));
      mockRowsQueue.push(rows);

      const result = await lookupCriticReviewsByAlbumIds([501]);
      const bucket = result.get(501);
      expect(bucket).toHaveLength(5);
      expect(bucket?.map((r) => r.source)).toEqual(['Source 0', 'Source 1', 'Source 2', 'Source 3', 'Source 4']);
    });

    it('pins the (album_id, published_at DESC NULLS LAST, id DESC) ORDER BY contract', async () => {
      mockRowsQueue.push([]);
      await lookupCriticReviewsByAlbumIds([501]);
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(1);
      expect(chainSpy.orderBy).toHaveBeenCalledWith('album_id', expect.anything(), expect.anything());
    });
  });

  describe('lookupWxycReviewsByAlbumId', () => {
    // Consented WXYC DJ reviews (ADR 0011). Two properties here are safety
    // properties, not merely shape contracts, and are asserted as such:
    //
    //   1. CONSENT GATE — the SQL must filter `social_consent = true`. The
    //      exhaustive row-level proof lives in the integration spec (real
    //      Postgres, real `false`/`NULL` rows); what this suite pins is that
    //      the predicate is present and is an equality against `true`, so a
    //      refactor to `IS NOT FALSE` / `IS NOT NULL` — which would publish
    //      unparsed, ambiguous consent answers — fails here.
    //   2. PII BARRIER — `reviewer_raw` / `social_consent_raw` must never be
    //      selected. The mocked table above declares both columns, so this
    //      assertion is a real barrier test rather than a vacuous one.

    it('returns [] when the linked album has no consented, non-empty reviews', async () => {
      mockRowsQueue.push([]);
      const result = await lookupWxycReviewsByAlbumId(42);
      expect(result).toEqual([]);
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('never selects the PII-internal columns (reviewer_raw / social_consent_raw)', async () => {
      mockRowsQueue.push([]);
      await lookupWxycReviewsByAlbumId(7);

      const projection = mockSelect.mock.calls[0][0] as Record<string, unknown>;
      const selected = Object.keys(projection);
      // Named explicitly, and NOT redundant with the exact-set assertion
      // below: these two survive a legitimate future widening of the wire
      // shape (which forces the literal list below to be edited, and could be
      // edited carelessly), so they keep guarding the columns that matter
      // most even then.
      expect(selected).not.toContain('reviewer_raw');
      expect(selected).not.toContain('social_consent_raw');
      // Nor may they hide inside a projected value (e.g. a raw sql fragment).
      const serialized = JSON.stringify(Object.values(projection));
      expect(serialized).not.toMatch(/reviewer_raw|social_consent_raw/);
      // The projection is exactly the five publish-safe wire fields. This is
      // the assertion that catches the realistic leak — a bare `select()` or
      // a spread, neither of which mentions a PII column by name.
      expect(selected.sort()).toEqual(
        ['artist_blurb', 'buzzwords', 'recommended_tracks', 'review', 'submitted_date'].sort()
      );
    });

    it('gates on social_consent = true (not IS NOT FALSE / IS NOT NULL)', async () => {
      mockRowsQueue.push([]);
      await lookupWxycReviewsByAlbumId(7);

      // Pinned as an exact structure rather than a loose "contains consent"
      // check: the whole safety property is that the consent comparison is
      // an equality against boolean `true`. Rewriting it as `isNotNull` or
      // `ne(..., false)` — either of which would publish rows whose consent
      // answer the ETL could not parse — changes this shape and fails here.
      expect(chainSpy.where).toHaveBeenCalledTimes(1);
      expect(chainSpy.where).toHaveBeenCalledWith({
        and: [{ eq: ['album_id', 7] }, { eq: ['social_consent', true] }, { isNotNull: 'review' }],
      });
    });

    it('renders submittedDate as a YYYY-MM-DD ET calendar date, not a timestamp', async () => {
      mockRowsQueue.push([]);
      await lookupWxycReviewsByAlbumId(7);

      const projection = mockSelect.mock.calls[0][0] as Record<string, unknown>;
      const submitted = renderSql(projection.submitted_date);
      // Formatted in SQL: `submitted_at` is timestamptz, so drizzle would
      // otherwise hand back a JS Date and the wire value would become a full
      // UTC ISO instant — wrong shape, and a day early for evening ET
      // submissions.
      expect(submitted).toContain('to_char');
      expect(submitted).toContain('YYYY-MM-DD');
      expect(submitted).toContain('America/New_York');
    });

    it('projects a full row onto the WxycReviewItem wire shape', async () => {
      mockRowsQueue.push([
        {
          review: 'Molina builds a whole room out of two notes and a loop pedal.',
          artist_blurb: 'Argentine songwriter, ex-comedian, patron saint of the loop.',
          recommended_tracks: 'la paradoja!!, ceramica',
          buzzwords: 'hypnotic, playful, unmoored',
          submitted_date: '2024-03-15',
        },
      ]);
      const result = await lookupWxycReviewsByAlbumId(7);
      expect(result).toEqual([
        {
          review: 'Molina builds a whole room out of two notes and a loop pedal.',
          artistBlurb: 'Argentine songwriter, ex-comedian, patron saint of the loop.',
          recommendedTracks: 'la paradoja!!, ceramica',
          buzzwords: 'hypnotic, playful, unmoored',
          submittedDate: '2024-03-15',
        },
      ]);
    });

    it('omits optional fields when null so decodeIfPresent stays compatible', async () => {
      mockRowsQueue.push([
        {
          review: 'Terse, and better for it.',
          artist_blurb: null,
          recommended_tracks: null,
          buzzwords: null,
          submitted_date: null,
        },
      ]);
      const result = await lookupWxycReviewsByAlbumId(7);
      expect(result).toEqual([{ review: 'Terse, and better for it.' }]);
      // No undefined optional keys leaked onto the item.
      expect(Object.keys(result[0])).toEqual(['review']);
    });

    it('caps the page at WXYC_REVIEWS_LIMIT (5)', async () => {
      mockRowsQueue.push([]);
      await lookupWxycReviewsByAlbumId(7);
      expect(chainSpy.limit).toHaveBeenCalledWith(5);
    });

    it('pins the newest-first ORDER BY (submitted_at DESC NULLS LAST, id DESC)', async () => {
      mockRowsQueue.push([]);
      await lookupWxycReviewsByAlbumId(7);
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(1);
      const [first, second] = chainSpy.orderBy.mock.calls[0];
      expect(renderSql(first).toLowerCase()).toContain('desc nulls last');
      expect(second).toEqual({ desc: 'id' });
    });
  });
});
