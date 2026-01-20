/**
 * LRU Cache utilities for Discogs API responses.
 *
 * Uses lru-cache for TTL-based caching to prevent rate limiting
 * and improve performance.
 *
 * Ported from request-parser discogs/cache.py
 */

import { LRUCache } from 'lru-cache';
import crypto from 'crypto';
import { getConfig } from '../requestLine/config.js';

/**
 * Generate a deterministic cache key from function name and arguments.
 */
export function makeCacheKey(funcName: string, args: unknown[]): string {
  const keyData = {
    fn: funcName,
    args: args,
  };
  const keyString = JSON.stringify(keyData, Object.keys(keyData).sort());
  return crypto.createHash('md5').update(keyString).digest('hex');
}

/**
 * Cache instances for different types of Discogs requests.
 */
let trackCache: LRUCache<string, unknown> | null = null;
let releaseCache: LRUCache<string, unknown> | null = null;
let searchCache: LRUCache<string, unknown> | null = null;

/**
 * Get or create the track search cache.
 */
export function getTrackCache(): LRUCache<string, unknown> {
  if (!trackCache) {
    const config = getConfig();
    trackCache = new LRUCache({
      max: config.discogsCacheMaxSize,
      ttl: config.discogsCacheTtlTrack * 1000, // Convert seconds to ms
    });
  }
  return trackCache;
}

/**
 * Get or create the release metadata cache.
 */
export function getReleaseCache(): LRUCache<string, unknown> {
  if (!releaseCache) {
    const config = getConfig();
    // Release cache uses half the maxsize since entries are larger
    releaseCache = new LRUCache({
      max: Math.floor(config.discogsCacheMaxSize / 2),
      ttl: config.discogsCacheTtlRelease * 1000,
    });
  }
  return releaseCache;
}

/**
 * Get or create the general search cache.
 */
export function getSearchCache(): LRUCache<string, unknown> {
  if (!searchCache) {
    const config = getConfig();
    searchCache = new LRUCache({
      max: config.discogsCacheMaxSize,
      ttl: config.discogsCacheTtlSearch * 1000,
    });
  }
  return searchCache;
}

/**
 * Clear all caches.
 */
export function clearAllCaches(): void {
  trackCache?.clear();
  releaseCache?.clear();
  searchCache?.clear();
}

/**
 * Reset all caches (recreate with fresh config).
 */
export function resetAllCaches(): void {
  trackCache = null;
  releaseCache = null;
  searchCache = null;
}

/**
 * Create a cached version of an async function.
 *
 * @param cache - LRU cache to use
 * @param funcName - Function name for cache key
 * @param fn - Async function to cache
 */
export function cached<T>(
  cache: LRUCache<string, unknown>,
  funcName: string,
  fn: (...args: unknown[]) => Promise<T>
): (...args: unknown[]) => Promise<T & { cached?: boolean }> {
  return async (...args: unknown[]): Promise<T & { cached?: boolean }> => {
    const key = makeCacheKey(funcName, args);

    // Check cache
    const cached = cache.get(key);
    if (cached !== undefined) {
      console.log(`[Discogs Cache] Hit for ${funcName}`);
      // Add cached flag if result is an object
      if (typeof cached === 'object' && cached !== null) {
        return { ...cached, cached: true } as T & { cached: boolean };
      }
      return cached as T;
    }

    // Cache miss - call function
    console.log(`[Discogs Cache] Miss for ${funcName}`);
    const result = await fn(...args);

    // Don't cache null/undefined results
    if (result !== null && result !== undefined) {
      cache.set(key, result);
    }

    return result as T & { cached?: boolean };
  };
}
