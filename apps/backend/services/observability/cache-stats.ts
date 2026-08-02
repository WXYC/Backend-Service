/**
 * Cache-stats observability helper (BS#989 / G6).
 *
 * Backend has eight in-process LRU caches spread across
 * `apps/backend/controllers/proxy.controller.ts` (artwork, negative,
 * tracklist, metadata_album, metadata_artist, entity_resolve, spotify_track)
 * and `apps/backend/services/library.service.ts` (track_search). None of
 * them projected `cache_hit` / size / eviction pressure onto the active
 * Sentry span, so cache effectiveness was invisible in the trace explorer.
 *
 * Mirrors the LML#213 `cache_stats` pattern already in production on
 * library-metadata-lookup: wrap-at-chokepoint + project-onto-span. This
 * module is the sole instrumentation site — callers at each cache touch
 * invoke `recordCacheLookup`/`recordCacheEviction` instead of hand-rolling
 * their own `Sentry.getActiveSpan()?.setAttributes(...)` call, so every
 * cache reports through one consistent attribute shape. No per-caller
 * instrumentation, no PostHog events, no separate metrics pipeline — the
 * Sentry span IS the metric surface.
 *
 * Two entry points:
 *
 *   - `recordCacheLookup(name, hit, cache)` — call once per get/set at a
 *     cache chokepoint. Projects `cache_hit` / `cache_name` / `cache_size` /
 *     `cache_capacity` onto whatever Sentry span is already active (the
 *     enclosing HTTP request span, or a caller-owned `Sentry.startSpan`
 *     child like `searchLibraryByTrackRaw`'s `catalog.track_search` span).
 *     Deliberately does NOT open a new span — per the ticket's constraint,
 *     wrap existing chokepoint spans, don't mint one per cache touch.
 *
 *   - `startPeriodicEmit(caches)` / `stopPeriodicEmit()` — a once-per-minute
 *     (per worker, default) timer that opens a single `op: 'BackgroundJob'`
 *     span and projects `cache.<name>.evictions.count` (since the previous
 *     emit) + `cache.<name>.size` for every registered cache, so eviction
 *     pressure is observable even without sampled request spans. Evictions
 *     are counted via `recordCacheEviction`, which callers wire into each
 *     `LRUCache`'s `dispose` option (filtered to `reason === 'evict'` —
 *     capacity-driven displacement — so TTL expiry, explicit `delete`, and
 *     `set`-triggered replacement don't pollute the eviction-pressure
 *     signal). Attribute keys are namespaced per cache name (rather than a
 *     bare `cache.evictions.count`) because one span reports on every
 *     registered cache at once; a flat key would have the last cache in the
 *     list clobber the rest.
 *
 * Observability must never break the request path: every Sentry call is
 * wrapped in try/catch with a `console.warn` fallback, matching the
 * try/catch idiom already used at every Sentry projection site in this
 * codebase (see proxy.controller.ts, library.service.ts).
 */
import * as Sentry from '@sentry/node';

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
 * Project `cache_hit`, `cache_name`, `cache_size`, `cache_capacity` onto the
 * active Sentry span for a single cache touch. Call this once per get/set
 * at the cache chokepoint — not per caller up the stack.
 */
export function recordCacheLookup(cacheName: CacheName, hit: boolean, cache: CacheLike): void {
  try {
    Sentry.getActiveSpan()?.setAttributes({
      cache_hit: hit,
      cache_name: cacheName,
      cache_size: cache.size,
      cache_capacity: cache.max,
    });
  } catch (err) {
    console.warn(`[CacheStats] failed to project span attributes for cache "${cacheName}"`, err);
  }
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
 * Open a single `op: 'BackgroundJob'` Sentry span and project
 * `cache.<name>.evictions.count` (since the previous *recorded* emit) +
 * `cache.<name>.size` for every registered cache, then reset the eviction
 * counters to 0 so the next emit reads as a rate, not a cumulative total.
 *
 * The reset is gated on `span.isRecording()`: when the BackgroundJob span is
 * sampled out, `setAttributes` is a no-op (the counts were never captured), so
 * resetting anyway would silently drop that interval's eviction pressure. When
 * unsampled we keep the running counts to roll into the next emit — the count
 * on a recorded emit is therefore "evictions since the last recorded emit,"
 * which stays a faithful (if coarser under low sampling) rate.
 *
 * Exported for direct invocation in tests/ad-hoc runs without waiting on the
 * interval; `startPeriodicEmit` is the production entry point.
 */
export function emitPeriodicCacheStats(caches: readonly RegisteredCache[]): void {
  try {
    Sentry.startSpan({ name: 'cache-stats-periodic-emit', op: 'BackgroundJob' }, (span) => {
      const attrs: Record<string, number> = {};
      for (const { name, cache } of caches) {
        attrs[`cache.${name}.evictions.count`] = evictionCounts.get(name) ?? 0;
        attrs[`cache.${name}.size`] = cache.size;
      }
      span.setAttributes(attrs);
      if (span.isRecording()) {
        for (const { name } of caches) evictionCounts.set(name, 0);
      }
    });
  } catch (err) {
    console.warn('[CacheStats] failed to project periodic cache-stats span', err);
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
