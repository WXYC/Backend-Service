/**
 * Bounded lookup for the BS#1962 SSE-feeder (`metadata-broadcast.ts`'s
 * realtime `liveFs:update` / `liveFs:insert` broadcast): an LRU +
 * in-flight-promise-coalescing wrapper over
 * `library.service.getDiscogsUnavailableFlagsById`.
 *
 * The SSE hot path can see a burst of terminal `liveFs:update`s writing
 * repeated `album_id`s (e.g. the `flowsheet-metadata-backfill` gap-recovery
 * sweep) — an uncached direct read per broadcast would be an unbounded
 * per-broadcast query (the AC this module exists to satisfy). This caps
 * reads to one per distinct `album_id` per TTL window:
 *
 *   - `max` ~2000 / `ttl` 60_000 ms, mirroring the sibling LRUs in
 *     `proxy.controller.ts`.
 *   - Value is `{ flags }`-wrapped (not a bare `DiscogsUnavailableFlags |
 *     undefined`) because `LRUCache`'s value type must extend `{}`, so an
 *     `undefined` (no library row) result needs a wrapper to be cacheable —
 *     same convention as `proxy.controller.ts`'s `artistMetadataCache` /
 *     `entityResolveCache`. Caching `undefined` is deliberate: a track with
 *     no library row stays a negative cache hit for the rest of the TTL
 *     rather than re-querying every broadcast.
 *   - In-flight-promise coalescing (`Map<number, InflightEntry>`) collapses
 *     concurrent lookups for the same `album_id` (e.g. a cold `insert`
 *     immediately followed by its terminal `update`) into one underlying
 *     read; both callers await the identical promise, so a same-row
 *     insert→update pair preserves broadcast ordering (FIFO by
 *     await-registration on the shared promise) — see `metadata-broadcast.ts`'s
 *     `setupMetadataBroadcast` docstring for the full ordering argument.
 *   - A rejected underlying read is NEVER cached (positive or negative) —
 *     only a *resolved* read (including a resolved `undefined`) is written
 *     to the LRU. A transient DB blip is retried on the next broadcast
 *     rather than pinned as a false "no library row" for the rest of the TTL.
 *
 * Staleness + invalidation (BS#1962): because a resolved `false`/`undefined`
 * is cached, a writer that flips `library.discogs_unavailable` — an MD's
 * interactive `PATCH /library/{id}`, or the `library-discogs-unavailable-
 * recheck` cron — could otherwise sit behind the TTL for up to 60 s, the
 * newly-flagged-album backfill-rebroadcast window this feature exists to
 * cover. Invalidation is driven off the SAME CDC stream the broadcasts
 * already consume rather than from the write path: `library` is CDC-tracked
 * (`cdc_library`, migration 0046), so `setupMetadataBroadcast` registers an
 * `onCdcEvent` handler that calls {@link invalidateDiscogsUnavailableFlags}
 * on every `library` UPDATE/DELETE. Because that NOTIFY reaches *every* BS
 * instance's LISTEN connection, the flipped album is dropped from *every*
 * instance's cache within one CDC round-trip — so the fresh flag appears on
 * the very next broadcast regardless of which instance serves it (a
 * write-path poke would only reach the one instance that served the PATCH).
 * The TTL remains the backstop if the CDC stream is unavailable.
 *
 * Invalidate-vs-in-flight-read TOCTOU: a bare `cache.delete` on invalidate
 * would not close the flip window if a read for the same `album_id` is already
 * in flight when the write lands — that read observed the *pre-flip* snapshot,
 * and its `.then` would re-pin the stale value into the cache *after* the
 * delete, resurrecting it for the rest of the TTL. Each in-flight read carries
 * a mutable `poisoned` flag on its {@link InflightEntry}; `invalidate` sets it,
 * and the read's `.then` skips the cache write when poisoned. The flag is
 * per-`album_id` (a shared counter would make an invalidation of one album
 * spuriously suppress the caching of unrelated in-flight reads) and lives only
 * as long as its entry, so nothing accumulates even though invalidation now
 * fires on every `library` write. The racing read still returns its pre-flip
 * value to its own caller (that broadcast reflects pre-flip state, which is
 * inherent and acceptable), but it never poisons the cache, so the *next* read
 * re-queries and observes the fresh flag.
 */

import { LRUCache } from 'lru-cache';
import { getDiscogsUnavailableFlagsById, type DiscogsUnavailableFlags } from '../library.service.js';

const CACHE_MAX = 2000;
const CACHE_TTL_MS = 60_000;

type CachedFlags = { flags: DiscogsUnavailableFlags | undefined };

const cache = new LRUCache<number, CachedFlags>({
  max: CACHE_MAX,
  ttl: CACHE_TTL_MS,
});

/**
 * One in-flight read: the shared promise concurrent callers await, plus a
 * mutable `poisoned` flag an invalidation sets so this read's now-stale result
 * is kept out of the cache. See the module docstring's "Invalidate-vs-in-flight-
 * read TOCTOU" note.
 */
type InflightEntry = { promise: Promise<CachedFlags>; poisoned: boolean };

/**
 * In-flight reads keyed by `album_id`. A second lookup for an `album_id`
 * already being read awaits the same promise rather than issuing a second
 * DB query. Cleared (success or failure) once the read settles, guarded by an
 * identity check so a settling read never evicts a newer read that replaced it.
 */
const inflight = new Map<number, InflightEntry>();

/**
 * Cache-through read of the BS#1281 discogs-unavailable flag trio for a
 * `library.id`, bounded by the LRU + in-flight coalescing described above.
 * Returns `undefined` when the album_id has no `library` row (mirrors
 * {@link getDiscogsUnavailableFlagsById}'s own contract) — callers merge the
 * result through `toDiscogsUnavailableWireFields` (`flowsheet-projection.ts`).
 *
 * Propagates a genuine DB error to the caller (never cached); the SSE feeder
 * wraps this call in its own additive-failure `try/catch` so a rejection
 * degrades to omitting the fields rather than failing the broadcast.
 */
export async function getCachedDiscogsUnavailableFlags(albumId: number): Promise<DiscogsUnavailableFlags | undefined> {
  const cached = cache.get(albumId);
  if (cached !== undefined) return cached.flags;

  const existing = inflight.get(albumId);
  if (existing) return (await existing.promise).flags;

  // Build the entry first (with a throwaway resolved promise) so the
  // `.then`/`.finally` closures below can capture it by reference — they run
  // only after the DB read settles, long after `entry.promise` is reassigned
  // synchronously below.
  const entry: InflightEntry = { poisoned: false, promise: Promise.resolve({ flags: undefined }) };
  entry.promise = (async (): Promise<CachedFlags> => {
    const flags = await getDiscogsUnavailableFlagsById(albumId);
    return { flags };
  })()
    .then((result) => {
      // Only a settled (resolved) read is cached — a rejection skips this
      // `.then` entirely, so nothing is written for a transient failure — and
      // only when no invalidation poisoned this read while it was in flight.
      if (!entry.poisoned) {
        cache.set(albumId, result);
      }
      return result;
    })
    .finally(() => {
      // Identity guard: only clear the slot if it still holds THIS entry. An
      // invalidation may have already deleted it and a newer read may now own
      // the slot — a bare `inflight.delete` would evict that newer read and
      // break its coalescing.
      if (inflight.get(albumId) === entry) {
        inflight.delete(albumId);
      }
    });

  inflight.set(albumId, entry);
  return (await entry.promise).flags;
}

/**
 * Drop any cached entry for `albumId` so the next
 * {@link getCachedDiscogsUnavailableFlags} call re-reads `library` instead of
 * serving a stale TTL-cached value. Registered against the CDC stream by
 * `metadata-broadcast.ts`'s `setupMetadataBroadcast` and fired on every
 * `library` UPDATE/DELETE (BS#1962), so a `discogs_unavailable` flip is dropped
 * from every BS instance's cache. Poisons any in-flight read for this id
 * (issued before the flip) so it cannot re-pin its now-stale value, and drops
 * the in-flight entry so the next caller starts a fresh read rather than
 * joining the doomed one. A no-op when the id is neither cached nor in flight.
 */
export function invalidateDiscogsUnavailableFlags(albumId: number): void {
  const existing = inflight.get(albumId);
  if (existing) existing.poisoned = true;
  cache.delete(albumId);
  inflight.delete(albumId);
}

/** Test-only: drop cached entries + in-flight promises between cases. */
export function __resetDiscogsUnavailableCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
