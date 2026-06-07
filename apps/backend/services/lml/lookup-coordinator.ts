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
 * `limiter`, and `warm_cache`. Subsequent coalescers await the in-flight
 * promise as-is — the wire request body is already serialized and in
 * flight by the time a coalescing caller arrives, so there is no
 * opportunity to union flags onto it. Write-path callers (`library-add-
 * album`, `library-canonical-entity`) set `warm_cache: true`; whether a
 * coalesced burst warms the LML PG cache is decided entirely by which
 * caller arrived first. Acceptable in practice: write-path callers
 * dominate same-key bursts that originate from a single user action, and
 * the warm-cache effect is a side benefit (LML's PG cache stays warm),
 * not a correctness invariant.
 *
 * **`warm_cache` on cache hits is a no-op.** When a cached response is
 * served (no wire call fires), the `warm_cache: true` flag the caller
 * passed never reaches LML — the PG cache is not warmed even when
 * explicitly requested. This is the same trade-off as first-caller-wins
 * extended to the cache layer: a read-path caller filling the LRU at T=0
 * locks out warm-cache effects for write-path callers arriving within
 * the 5-min TTL. `warm_cache` remains best-effort across both paths;
 * the LML PG cache has its own (longer) TTL and is repopulated by
 * subsequent reads regardless.
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
> & {
  /**
   * When set, the coordinator returns `null` if the resolved response's
   * `search_type` doesn't match, after projecting
   * `lml.coordinator.trust_reject_reason` onto the per-lookup span. The
   * raw response is still cached — the gate runs per-call so a permissive
   * caller and a strict caller can share a cached payload and reach
   * different verdicts. Used by librarian-typed write paths where
   * non-direct results would persist the wrong release. BS#1355.
   */
  requireSearchType?: 'direct';
};

interface InFlightEntry {
  promise: Promise<LookupResponse>;
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
   * cached. When `requireSearchType` is set, returns `null` on mismatch
   * after projecting `lml.coordinator.trust_reject_reason` onto the span;
   * otherwise the return is the raw `LookupResponse`.
   */
  async lookup(
    artist: string | undefined,
    album: string | undefined,
    song: string | undefined,
    options: CoordinatorLookupOptions & { requireSearchType: 'direct' }
  ): Promise<LookupResponse | null>;
  async lookup(
    artist: string | undefined,
    album: string | undefined,
    song: string | undefined,
    options?: Omit<CoordinatorLookupOptions, 'requireSearchType'>
  ): Promise<LookupResponse>;
  async lookup(
    artist: string | undefined,
    album: string | undefined,
    song: string | undefined,
    options?: CoordinatorLookupOptions
  ): Promise<LookupResponse | null> {
    const key = this.cacheKey(artist, album, song);
    const caller = options?.caller ?? 'unknown';

    return Sentry.startSpan({ name: 'lml.coordinator.lookup', op: 'function' }, async (span) => {
      const cached = this.cache.get(key);
      if (cached) {
        this.setSpanAttrs(span, { hit: 'cache', caller });
        return this.applyTrustGate(cached, options, span);
      }

      const existing = this.inflight.get(key);
      if (existing) {
        this.setSpanAttrs(span, { hit: 'inflight', caller });
        return this.applyTrustGate(await existing.promise, options, span);
      }

      // Populate cache BEFORE releasing the in-flight entry. The naive
      // `.finally(() => inflight.delete(key))` runs *before* the outer
      // `await promise` resumes to set the cache, opening a microtask
      // gap where a same-key caller arriving in the gap sees neither
      // cache nor inflight and issues a redundant wire call. Sequencing
      // cache.set → inflight.delete inside the settle chain itself
      // closes the gap — an arriving caller always sees the cache hit
      // by the next event-loop turn. Rejections skip the success arm
      // and propagate through `.finally`; the in-flight entry is then
      // cleared without caching the error, so the next request retries.
      //
      // **Read-only contract**: the cached `LookupResponse` is returned
      // by reference to every coalesced + cache-hit caller for up to 5
      // min. Callsites must NOT mutate the response or any nested field
      // (`results`, `artwork`, etc.) — doing so poisons subsequent reads.
      // All current callsites read-only; a deep freeze would be safer
      // but costs O(n) per cache-set on every response. Tracked as a
      // follow-up if mutation footguns appear.
      // Pass the resolved `caller` (not the raw `options?.caller`) so the
      // wire span's `lml.caller` attribute matches what we projected onto
      // the coordinator span — single source of truth for the "unknown"
      // default. The other options forward as-is.
      const settle = this.fetchUncached(artist, album, song, { ...options, caller })
        .then((result) => {
          this.cache.set(key, result);
          return result;
        })
        .finally(() => {
          this.inflight.delete(key);
        });
      this.inflight.set(key, { promise: settle });
      this.setSpanAttrs(span, { hit: 'miss', caller });

      return this.applyTrustGate(await settle, options, span);
    });
  }

  /**
   * Per-call gate: cached responses are stored raw so a permissive caller
   * and a strict caller can share one cached payload and reach different
   * verdicts. The rejection attribute lands on the per-lookup span,
   * co-located with `lml.coordinator.hit` and `.caller`.
   */
  private applyTrustGate(
    response: LookupResponse,
    options: CoordinatorLookupOptions | undefined,
    span: ReturnType<typeof Sentry.getActiveSpan>
  ): LookupResponse | null {
    if (!options?.requireSearchType) return response;
    if (response.search_type === options.requireSearchType) return response;
    if (span) {
      try {
        span.setAttribute('lml.coordinator.trust_reject_reason', `search_type:${response.search_type}`);
      } catch (err) {
        console.warn('lml.coordinator: failed to project trust_reject_reason onto span', err);
      }
    }
    return null;
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
