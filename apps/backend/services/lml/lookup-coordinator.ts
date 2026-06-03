/**
 * Single chokepoint that fronts every `lookupMetadata` call from the
 * `@wxyc/backend` API process (BS#885 / Epic B / B2).
 *
 * Two collapsing strategies, both per-process:
 *
 *   1. **In-flight coalescing.** Concurrent callers asking for the same
 *      `(artist, album, song)` await one Promise; the first caller's wire
 *      call services every coalescer.
 *   2. **Short-TTL response cache.** Successful `LookupResponse` payloads
 *      memoize for 5 min in a process-local LRU. LML's PG cache remains
 *      the source of truth; this is "we asked LML 30 s ago, the answer
 *      hasn't changed yet."
 *
 * Cross-instance coalescing (Redis / PG advisory locks) is out of scope —
 * dj-site session stickiness collapses most same-key bursts onto one
 * replica.
 *
 * **`extended: true` is forced** on every wire call so cached responses
 * are usable by any caller regardless of which extended fields they
 * actually consume (BS#885 mandate). Cost: ~1 KB payload growth per
 * response; LML's downstream work is unchanged because it's already
 * driven by `extended`.
 *
 * **First-caller-wins on the wire** for `caller`, `budgetMs`, `timeoutMs`,
 * `limiter`. Subsequent coalescers await the in-flight promise as-is. The
 * `warm_cache` flag accumulates — if ANY in-flight caller asks for it the
 * wire call carries `warm_cache: true` (write-path callers opt in; read-
 * path callers don't). On error the in-flight entry is discarded along
 * with the accumulated `warm_cache` flag — a subsequent retry rebuilds
 * the flag from the new coalescing population.
 *
 * **No error caching.** Throws propagate to all waiters; the next request
 * for the same key issues a fresh wire call. LML's own short cache TTL
 * on errors handles avalanche.
 */
import * as Sentry from '@sentry/node';
import { LRUCache } from 'lru-cache';

import { lookupMetadata, type LookupOptions, type LookupResponse } from '@wxyc/lml-client';

/**
 * Options accepted by `LmlLookupCoordinator.lookup`. Mirrors `LookupOptions`
 * except `extended` is intentionally omitted — the coordinator always passes
 * `extended: true` so cached responses are valid for every caller.
 */
export type CoordinatorLookupOptions = Pick<
  LookupOptions,
  'budgetMs' | 'timeoutMs' | 'caller' | 'warm_cache' | 'limiter'
>;

interface InFlightEntry {
  promise: Promise<LookupResponse>;
  /** Caller tags collected from the originating call and every coalescer; surfaced on the span. */
  callers: Set<string>;
  /** Union across coalesced callers: any `warm_cache: true` sets this true. Discarded on error. */
  warmCacheRequested: boolean;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class LmlLookupCoordinator {
  private readonly inflight = new Map<string, InFlightEntry>();
  private readonly cache: LRUCache<string, LookupResponse>;

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.cache = new LRUCache({
      max: opts?.maxEntries ?? DEFAULT_MAX_ENTRIES,
      ttl: opts?.ttlMs ?? DEFAULT_TTL_MS,
    });
  }

  /**
   * Look up metadata for an artist/album/song triple. Coalesces concurrent
   * same-key calls; serves cached responses within TTL. Errors are not
   * cached.
   */
  async lookup(
    artist: string | undefined,
    album: string | undefined,
    song: string | undefined,
    options?: CoordinatorLookupOptions
  ): Promise<LookupResponse> {
    const key = this.cacheKey(artist, album, song);
    const caller = options?.caller ?? 'unknown';

    return Sentry.startSpan({ name: 'lml.coordinator.lookup', op: 'function' }, async (span) => {
      const cached = this.cache.get(key);
      if (cached) {
        this.setSpanAttrs(span, { hit: 'cache', caller });
        return cached;
      }

      const existing = this.inflight.get(key);
      if (existing) {
        existing.callers.add(caller);
        if (options?.warm_cache) existing.warmCacheRequested = true;
        this.setSpanAttrs(span, { hit: 'inflight', caller });
        return existing.promise;
      }

      const promise = this.fetchUncached(artist, album, song, options).finally(() => {
        this.inflight.delete(key);
      });

      const entry: InFlightEntry = {
        promise,
        callers: new Set([caller]),
        warmCacheRequested: !!options?.warm_cache,
      };
      this.inflight.set(key, entry);
      this.setSpanAttrs(span, { hit: 'miss', caller });

      const result = await promise;
      this.cache.set(key, result);
      return result;
    });
  }

  private async fetchUncached(
    artist: string | undefined,
    album: string | undefined,
    song: string | undefined,
    options: CoordinatorLookupOptions | undefined
  ): Promise<LookupResponse> {
    return lookupMetadata(artist, album, song, {
      extended: true,
      warm_cache: options?.warm_cache,
      budgetMs: options?.budgetMs,
      timeoutMs: options?.timeoutMs,
      caller: options?.caller,
      limiter: options?.limiter,
    });
  }

  /**
   * `undefined` and `''` both normalize to `∅` — both express "no value for
   * this field." Whitespace is trimmed, internal runs collapse to a single
   * space, casing is folded. No diacritic folding — LML's parser handles
   * fuzzy matching.
   */
  private cacheKey(artist: string | undefined, album: string | undefined, song: string | undefined): string {
    return [normalize(artist), normalize(album), normalize(song)].join('|');
  }

  private setSpanAttrs(
    span: ReturnType<typeof Sentry.getActiveSpan>,
    attrs: { hit: 'cache' | 'inflight' | 'miss'; caller: string }
  ): void {
    if (!span) return;
    try {
      span.setAttributes({
        'lml.coordinator.hit': attrs.hit,
        'lml.coordinator.caller': attrs.caller,
      });
    } catch (err) {
      console.warn('lml.coordinator: failed to project attrs onto span', err);
    }
  }
}

function normalize(s: string | undefined): string {
  if (!s) return '∅';
  const trimmed = s.trim();
  if (trimmed === '') return '∅';
  return trimmed.toLowerCase().replace(/\s+/g, ' ');
}

/** Process-wide singleton. Module-load shape mirrors `defaultLimiter` in `@wxyc/lml-client`. */
export const lmlLookupCoordinator = new LmlLookupCoordinator();

/**
 * Test-only — clears the singleton's in-flight + cache maps so tests don't
 * leak state across cases. Mirrors `_resetLmlClientLimitersForTest()` in
 * `@wxyc/lml-client`.
 */
export function _resetLmlLookupCoordinatorForTest(): void {
  // eslint-disable-next-line @typescript-eslint/dot-notation
  (lmlLookupCoordinator['inflight'] as Map<string, InFlightEntry>).clear();
  // eslint-disable-next-line @typescript-eslint/dot-notation
  (lmlLookupCoordinator['cache'] as LRUCache<string, LookupResponse>).clear();
}
