/**
 * Run-scoped (artist, album) lookup dedup cache for the historical
 * metadata drain (peer ticket to BS#1011 / Slot 6 of BS#1279).
 *
 * Prod measurement on 2026-06-03: 628,561 pending unlinked flowsheet rows
 * resolve to 362,258 distinct (artist_name, album_title) pairs — a 1.74×
 * multiplier. A cron-lifetime Map cuts the LML call budget by ~42% without
 * pacing changes, schema changes, or cross-repo work.
 *
 * Lifetime is the cron container — daily `docker rm -f` is the eviction
 * strategy. No LRU, no size cap. Worst-case memory at today's volume is
 * ~40MB; container has tens of GB of headroom. A soft warning log fires
 * at `size > 50000` so a regression that would push past ~250MB surfaces
 * in logs.
 *
 * Streaming URL stripping is the cache's concern, not the orchestrator's.
 * `get()` returns a shallow-copied response with `artwork.spotify_url`,
 * `youtube_music_url`, `bandcamp_url`, `soundcloud_url` rewritten to
 * `undefined`. enrich.ts's existing `??` fallback then drops through to
 * per-row `synthesizeSearchUrls(row)`. Required because LML's streaming
 * URLs are track-aware (BS#1185) — caching album-level search URLs and
 * applying to a different track would surface a mismatched query.
 *
 * The non-stripped, album-level metadata is shared verbatim across rows
 * sharing the same (artist, album): `release_id`, `release_url`,
 * `artwork_url`, `release_year`, `apple_music_url`, `artist_bio`,
 * `wikipedia_url`. Caveat acknowledged: caching on (artist, album) and
 * applying to multiple tracks accepts a small risk that LML's
 * track-presence verification would have returned a different release
 * for a different track. For the backfill's use case (album-level
 * metadata for historical flowsheet views), this is acceptable.
 */

import type { LookupResponse } from '@wxyc/lml-client';

import { log } from './logger.js';

const SIZE_WARN_THRESHOLD = 50_000;

const normalize = (s: string): string => s.trim().normalize('NFKC').toLowerCase();

const makeKey = (artist: string, album: string | null | undefined): string =>
  normalize(artist) + '\0' + normalize(album ?? '');

/**
 * The fields blanked when reading from the cache. These are per-row search
 * URLs (track-aware on LML's side); enrich.ts synthesizes its own copies
 * via `synthesizeSearchUrls(row)` and its `??` fallback applies them.
 */
const STREAMING_URL_FIELDS = ['spotify_url', 'youtube_music_url', 'bandcamp_url', 'soundcloud_url'] as const;

type ArtworkBlock = NonNullable<LookupResponse['results'][number]['artwork']>;

const stripStreamingUrls = (response: LookupResponse): LookupResponse => {
  if (response.results.length === 0) return response;
  return {
    ...response,
    results: response.results.map((item) => {
      if (!item.artwork) return item;
      const stripped: ArtworkBlock = { ...item.artwork };
      for (const field of STREAMING_URL_FIELDS) {
        stripped[field] = undefined;
      }
      return { ...item, artwork: stripped };
    }),
  };
};

export class LookupCache {
  private readonly store = new Map<string, LookupResponse>();
  private hits = 0;
  private misses = 0;
  private warnedOversize = false;

  get(artist: string, album?: string | null): LookupResponse | undefined {
    const key = makeKey(artist, album);
    const entry = this.store.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return stripStreamingUrls(entry);
  }

  set(artist: string, album: string | null | undefined, response: LookupResponse): void {
    const key = makeKey(artist, album);
    this.store.set(key, response);
    if (!this.warnedOversize && this.store.size > SIZE_WARN_THRESHOLD) {
      this.warnedOversize = true;
      log('warn', 'lookup_cache_oversize', `LookupCache size exceeded ${SIZE_WARN_THRESHOLD}`, {
        cache_size: this.store.size,
        threshold: SIZE_WARN_THRESHOLD,
      });
    }
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.store.size, hits: this.hits, misses: this.misses };
  }
}

/**
 * Module-level singleton wired into `lml-fetch.ts`. Tests construct their
 * own `LookupCache` instance; they do not touch this singleton.
 */
export const defaultLookupCache = new LookupCache();
