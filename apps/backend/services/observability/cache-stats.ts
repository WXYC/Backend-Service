/**
 * Cache-stats observability helper (BS#989 / G6, moved to log lines in BS#3402).
 *
 * Backend has eight in-process LRU caches spread across
 * `apps/backend/controllers/proxy.controller.ts` (artwork, negative,
 * tracklist, metadata_album, metadata_artist, entity_resolve, spotify_track)
 * and `apps/backend/services/library.service.ts` (track_search). This module
 * is the sole instrumentation site: callers at each cache touch invoke
 * `recordCacheLookup`/`recordCacheEviction`, so every cache reports through
 * one consistent shape. Signals are structured log lines (`logCounter`), not
 * span attributes.
 *
 *   - `recordCacheLookup(name, hit, cache)` — call once per get/set at a
 *     cache chokepoint. Logs `cache.lookup` with `cache_hit` / `cache_name` /
 *     `cache_size` / `cache_capacity`.
 *
 *   - `startPeriodicEmit(caches)` / `stopPeriodicEmit()` — a once-per-minute
 *     (per worker, default) timer that logs `cache.<name>.evictions.count`
 *     (since the previous emit) + `cache.<name>.size` for every registered
 *     cache. Evictions are counted via `recordCacheEviction`, which callers
 *     wire into each `LRUCache`'s `dispose` option (filtered to
 *     `reason === 'evict'` — capacity-driven displacement — so TTL expiry,
 *     explicit `delete`, and `set`-triggered replacement don't pollute the
 *     eviction-pressure signal).
 *
 * `logCounter` never throws, so observability cannot break the request path.
 */
import { logCounter } from '@wxyc/observability';

/** The eight in-process LRU caches this module instruments (BS#989). */
export type CacheName =
  | 'artwork'
  | 'negative'
  | 'tracklist'
  | 'track_search'
  | 'metadata_album'
  | 'metadata_artist'
  | 'entity_resolve'
  | 'spotify_track';

/** Minimal shape `recordCacheLookup`/`emitPeriodicCacheStats` need from an `LRUCache` instance. */
export interface CacheLike {
  readonly size: number;
  readonly max: number;
}

/** A cache instance registered for the periodic eviction/size emit. */
export interface RegisteredCache {
  name: CacheName;
  cache: CacheLike;
}

const DEFAULT_PERIODIC_EMIT_INTERVAL_MS = 60_000;

/** Running eviction counts since the last `emitPeriodicCacheStats` call, keyed by cache name. */
const evictionCounts = new Map<CacheName, number>();

let periodicEmitTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Log `cache.lookup` with `cache_hit`, `cache_name`, `cache_size` and
 * `cache_capacity` for a single cache touch. Call this once per get/set
 * at the cache chokepoint — not per caller up the stack.
 */
export function recordCacheLookup(cacheName: CacheName, hit: boolean, cache: CacheLike): void {
  logCounter('cache.lookup', 1, {
    cache_hit: hit,
    cache_name: cacheName,
    cache_size: cache.size,
    cache_capacity: cache.max,
  });
}

/**
 * Record one capacity-driven eviction on `cacheName`. Wire this into an
 * `LRUCache`'s `dispose` option, filtered to `reason === 'evict'` — see the
 * module doc above for why other dispose reasons are excluded.
 */
export function recordCacheEviction(cacheName: CacheName): void {
  evictionCounts.set(cacheName, (evictionCounts.get(cacheName) ?? 0) + 1);
}

/**
 * Log `cache.<name>.evictions.count` (since the previous emit) and
 * `cache.<name>.size` for every registered cache, one line each, then reset
 * the eviction counters to 0 so the next emit reads as a rate, not a
 * cumulative total.
 *
 * Exported for direct invocation in tests/ad-hoc runs without waiting on the
 * interval; `startPeriodicEmit` is the production entry point.
 */
export function emitPeriodicCacheStats(caches: readonly RegisteredCache[]): void {
  for (const { name, cache } of caches) {
    logCounter(`cache.${name}.evictions.count`, evictionCounts.get(name) ?? 0);
    logCounter(`cache.${name}.size`, cache.size);
    evictionCounts.set(name, 0);
  }
}

/**
 * Reads `CACHE_STATS_PERIODIC_EMIT_INTERVAL_MS`, falling back to the
 * once-per-minute default on unset/non-numeric/non-positive values.
 * Mirrors `album-plays-refresh.service.ts`'s `readIntervalFromEnv` shape.
 */
function readIntervalFromEnv(): number {
  const raw = process.env.CACHE_STATS_PERIODIC_EMIT_INTERVAL_MS;
  if (!raw) return DEFAULT_PERIODIC_EMIT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERIODIC_EMIT_INTERVAL_MS;
}

/**
 * Start the once-per-minute (per worker, default) periodic emit. Call once
 * at worker init, after every cache-owning module has loaded (so
 * `caches` reflects the full registered set) — see `apps/backend/app.ts`.
 * Idempotent: a second call while a timer is already running is a no-op,
 * matching `startSseMetrics`'s convention.
 */
export function startPeriodicEmit(
  caches: readonly RegisteredCache[],
  intervalMs: number = readIntervalFromEnv()
): void {
  if (periodicEmitTimer !== null) return;
  periodicEmitTimer = setInterval(() => emitPeriodicCacheStats(caches), intervalMs);
  periodicEmitTimer.unref?.();
}

/** Cancel the periodic emit timer. Safe to call when not running (e.g. shutdown, tests). */
export function stopPeriodicEmit(): void {
  if (periodicEmitTimer !== null) {
    clearInterval(periodicEmitTimer);
    periodicEmitTimer = null;
  }
}

/** Test-only: reset eviction counters and cancel any running timer between cases. */
export function __resetCacheStatsForTests(): void {
  evictionCounts.clear();
  stopPeriodicEmit();
}
