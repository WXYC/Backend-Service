/**
 * Tests for the run-scoped (artist, album) lookup dedup cache used by the
 * historical metadata drain. See plans/flowsheet-backfill-lookup-dedup.md
 * (peer ticket to BS#1011 / Slot 6 of BS#1279).
 *
 * The cache lives for the cron container's lifetime — no LRU, no eviction —
 * and the daily docker rm -f is the eviction strategy.
 *
 * Three invariants this file pins:
 *   1. Key normalization: case + whitespace + NFKC fold to the same slot
 *      so 'The Beatles' / 'the beatles' / '  the beatles  ' don't get
 *      separate cache entries, and 'Beyoncé' typed composed vs decomposed
 *      collide.
 *   2. NULL / undefined / '' for album are the *same* slot (artist-only
 *      semantics, matching LML's lookup), but distinct from a real album
 *      title. The NUL separator on the key prevents
 *      `('Beatles', '') === ('Beatle', 's')` style collisions.
 *   3. `get()` returns a shallow-copied response with the four streaming
 *      URL fields (spotify_url, youtube_music_url, bandcamp_url,
 *      soundcloud_url) on the artwork block rewritten to `undefined`.
 *      LML's streaming URLs are track-aware (BS#1185); blanking them at
 *      the cache boundary lets enrich.ts's existing `??` fallback drop
 *      through to per-row `synthesizeSearchUrls(row)`. Required so dedup
 *      across multiple tracks on the same album doesn't surface another
 *      track's search query.
 */

import type { LookupResponse } from '@wxyc/lml-client';

import { LookupCache } from '../../../../jobs/flowsheet-metadata-backfill/lookup-cache';

const makeResponse = (
  overrides: Partial<NonNullable<LookupResponse['results'][0]['artwork']>> = {}
): LookupResponse => ({
  results: [
    {
      library_item: {
        id: 1,
        call_number: 'Rock CD ABC 123/45',
        library_url: 'https://wxyc.org/library/1',
      },
      artwork: {
        release_id: 999,
        release_url: 'https://www.discogs.com/release/999',
        confidence: 0.95,
        artwork_url: 'https://discogs.example/cover.jpg',
        release_year: 1969,
        artist_bio: 'A rock band.',
        wikipedia_url: 'https://en.wikipedia.org/wiki/Example',
        spotify_url: 'https://open.spotify.com/album/abc',
        apple_music_url: 'https://music.apple.com/album/123',
        youtube_music_url: 'https://music.youtube.com/playlist?list=OLAK',
        bandcamp_url: 'https://example.bandcamp.com/album/abc',
        soundcloud_url: 'https://soundcloud.com/example/sets/abc',
        ...overrides,
      },
    },
  ],
  search_type: 'direct',
  song_not_found: false,
  found_on_compilation: false,
});

describe('LookupCache (run-scoped (artist, album) dedup)', () => {
  describe('key normalization', () => {
    it('case + whitespace fold to the same slot', () => {
      const cache = new LookupCache();
      const response = makeResponse();

      cache.set('The Beatles', 'Abbey Road', response);

      expect(cache.get('The Beatles', 'Abbey Road')).not.toBeUndefined();
      expect(cache.get('the beatles', 'abbey road')).not.toBeUndefined();
      expect(cache.get('  The Beatles  ', '  Abbey Road  ')).not.toBeUndefined();
      expect(cache.get('THE BEATLES', 'ABBEY ROAD')).not.toBeUndefined();
      expect(cache.stats().size).toBe(1);
    });

    it('NFKC composed and decomposed forms of accented names collide', () => {
      // 'Beyoncé' as a single composed code point (U+0065 + U+0301 vs U+00E9).
      // If normalize() is accidentally called with 'NFC' instead of 'NFKC', the
      // decomposed input would normalize to NFC and still match here — to
      // genuinely guard the NFKC choice, use the compatibility-decomposable
      // ligature 'ﬁ' (U+FB01) vs 'fi' which only NFKC folds together.
      const cache = new LookupCache();
      const response = makeResponse();

      const composed = 'Beyoncé'; // Beyoncé (single code point)
      const decomposed = 'Beyoncé'; // Beyonce + combining acute
      cache.set(composed, 'Lemonade', response);

      const fromComposed = cache.get(composed, 'Lemonade');
      const fromDecomposed = cache.get(decomposed, 'Lemonade');

      expect(fromComposed).not.toBeUndefined();
      expect(fromDecomposed).not.toBeUndefined();
      // Both inputs must actually return the cached value, not just produce
      // colliding keys. Pinning the result guards against an accidental
      // `'NFC'` typo in `String.prototype.normalize()`.
      expect(fromComposed?.results[0].artwork?.release_id).toBe(999);
      expect(fromDecomposed?.results[0].artwork?.release_id).toBe(999);
      expect(cache.stats().size).toBe(1);
    });

    it('NFKC ligature ﬁ folds to fi (compatibility decomposition, not pure NFC)', () => {
      // The ligature 'ﬁ' (U+FB01) is the NFKC-canonical guard: NFC leaves it
      // alone, only NFKC folds it to 'fi'. If someone swaps 'NFKC' for 'NFC',
      // this test fails — the NFC test above can't distinguish them.
      const cache = new LookupCache();
      const response = makeResponse();

      cache.set('Fiﬁnale', 'Album', response); // 'Fiﬁnale'

      expect(cache.get('Finale', 'Album')).toBeUndefined(); // different word
      expect(cache.get('Fifinale', 'Album')).not.toBeUndefined(); // ligature → 'fi'
      expect(cache.stats().size).toBe(1);
    });
  });

  describe('NULL / undefined / "" album disambiguation', () => {
    it.each<[string, string | null | undefined]>([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
    ])('treats album=%s as the artist-only slot', (_label, album) => {
      const cache = new LookupCache();
      const artistOnly = makeResponse({ release_id: 1 });
      cache.set('The Beatles', null, artistOnly);

      const hit = cache.get('The Beatles', album);
      expect(hit).not.toBeUndefined();
      expect(hit?.results[0].artwork?.release_id).toBe(1);
    });

    it('distinguishes artist-only from artist+album, and album titles from each other', () => {
      const cache = new LookupCache();
      const slotA = makeResponse({ release_id: 100 }); // artist-only
      const slotB = makeResponse({ release_id: 200 }); // Abbey Road
      const slotC = makeResponse({ release_id: 300 }); // Let It Be

      cache.set('The Beatles', null, slotA);
      cache.set('The Beatles', 'Abbey Road', slotB);
      cache.set('The Beatles', 'Let It Be', slotC);

      expect(cache.get('The Beatles', null)?.results[0].artwork?.release_id).toBe(100);
      expect(cache.get('The Beatles', undefined)?.results[0].artwork?.release_id).toBe(100);
      expect(cache.get('The Beatles', '')?.results[0].artwork?.release_id).toBe(100);
      expect(cache.get('The Beatles', 'Abbey Road')?.results[0].artwork?.release_id).toBe(200);
      expect(cache.get('The Beatles', 'Let It Be')?.results[0].artwork?.release_id).toBe(300);
      expect(cache.stats().size).toBe(3);
    });

    it('NUL separator prevents adjacent-segment collisions', () => {
      // Without the NUL: ('Beatles', '') and ('Beatle', 's') both lowercase
      // to the concatenated string 'beatles'. Two distinct lookup intents
      // would share a slot. The NUL byte enforces a hard boundary.
      const cache = new LookupCache();
      const a = makeResponse({ release_id: 1 });
      const b = makeResponse({ release_id: 2 });

      cache.set('Beatles', '', a);
      cache.set('Beatle', 's', b);

      expect(cache.get('Beatles', '')?.results[0].artwork?.release_id).toBe(1);
      expect(cache.get('Beatle', 's')?.results[0].artwork?.release_id).toBe(2);
      expect(cache.stats().size).toBe(2);
    });
  });

  describe('hit / miss accounting', () => {
    it('counts misses on get() of unset keys', () => {
      const cache = new LookupCache();
      expect(cache.get('Unknown', 'Album')).toBeUndefined();
      expect(cache.get('Unknown', 'Another')).toBeUndefined();
      expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 2 });
    });

    it('counts hits on get() of set keys', () => {
      const cache = new LookupCache();
      cache.set('Sonic Youth', 'Daydream Nation', makeResponse());

      cache.get('Sonic Youth', 'Daydream Nation');
      cache.get('Sonic Youth', 'Daydream Nation');
      cache.get('Sonic Youth', 'Daydream Nation');

      expect(cache.stats()).toEqual({ size: 1, hits: 3, misses: 0 });
    });

    it('size grows monotonically; same key does not double-count', () => {
      const cache = new LookupCache();
      cache.set('A', 'X', makeResponse());
      cache.set('B', 'X', makeResponse());
      cache.set('A', 'X', makeResponse()); // overwrite, not new slot
      expect(cache.stats().size).toBe(2);
    });
  });

  describe('streaming URL stripping on get()', () => {
    it('blanks all four streaming URL fields on the artwork block', () => {
      const cache = new LookupCache();
      cache.set('Sonic Youth', 'Daydream Nation', makeResponse());

      const hit = cache.get('Sonic Youth', 'Daydream Nation');
      expect(hit).toBeDefined();
      const artwork = hit?.results[0].artwork;
      expect(artwork?.spotify_url).toBeUndefined();
      expect(artwork?.youtube_music_url).toBeUndefined();
      expect(artwork?.bandcamp_url).toBeUndefined();
      expect(artwork?.soundcloud_url).toBeUndefined();
    });

    it('preserves album-level metadata fields on the artwork block', () => {
      const cache = new LookupCache();
      cache.set('Sonic Youth', 'Daydream Nation', makeResponse());

      const hit = cache.get('Sonic Youth', 'Daydream Nation');
      const artwork = hit?.results[0].artwork;
      expect(artwork?.release_id).toBe(999);
      expect(artwork?.release_url).toBe('https://www.discogs.com/release/999');
      expect(artwork?.artwork_url).toBe('https://discogs.example/cover.jpg');
      expect(artwork?.release_year).toBe(1969);
      expect(artwork?.apple_music_url).toBe('https://music.apple.com/album/123');
      expect(artwork?.artist_bio).toBe('A rock band.');
      expect(artwork?.wikipedia_url).toBe('https://en.wikipedia.org/wiki/Example');
    });

    it('does not mutate the originally cached object across reads', () => {
      // Hot invariant: the cached entry must stay pristine so a second
      // get() also sees the album-level fields intact, and a regression
      // that swaps shallow-copy for in-place mutation surfaces here.
      const cache = new LookupCache();
      const original = makeResponse();
      cache.set('Sonic Youth', 'Daydream Nation', original);

      cache.get('Sonic Youth', 'Daydream Nation');
      cache.get('Sonic Youth', 'Daydream Nation');

      expect(original.results[0].artwork?.spotify_url).toBe('https://open.spotify.com/album/abc');
      expect(original.results[0].artwork?.youtube_music_url).toBe('https://music.youtube.com/playlist?list=OLAK');
      expect(original.results[0].artwork?.bandcamp_url).toBe('https://example.bandcamp.com/album/abc');
      expect(original.results[0].artwork?.soundcloud_url).toBe('https://soundcloud.com/example/sets/abc');
    });

    it('tolerates an empty results array (no-match LML response)', () => {
      const cache = new LookupCache();
      const noMatch: LookupResponse = {
        results: [],
        search_type: 'none',
        song_not_found: true,
        found_on_compilation: false,
      };
      cache.set('Unknown Artist', 'Unknown Album', noMatch);

      const hit = cache.get('Unknown Artist', 'Unknown Album');
      expect(hit).toBeDefined();
      expect(hit?.results).toEqual([]);
      expect(hit?.song_not_found).toBe(true);
    });

    it('tolerates a result with no artwork field (LML no-match shape)', () => {
      const cache = new LookupCache();
      const noArtwork: LookupResponse = {
        results: [
          {
            library_item: {
              id: 7,
              call_number: 'Rock CD ZZZ 0/0',
              library_url: 'https://wxyc.org/library/7',
            },
            // artwork omitted intentionally
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      };
      cache.set('A', 'B', noArtwork);

      const hit = cache.get('A', 'B');
      expect(hit).toBeDefined();
      expect(hit?.results[0].artwork).toBeUndefined();
    });
  });
});
