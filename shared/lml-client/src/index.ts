/**
 * HTTP client for the library-metadata-lookup (LML) service.
 *
 * Thin wrapper around LML's endpoints. Reads LIBRARY_METADATA_URL from env.
 * All methods throw on non-2xx responses so the proxy controller's try/catch
 * blocks can translate to appropriate HTTP error codes.
 *
 * Response types are generated from wxyc-shared/api.yaml — see @wxyc/shared/dtos.
 */

import * as Sentry from '@sentry/node';

import type {
  DiscogsReleaseMetadata,
  DiscogsArtistDetails,
  DiscogsTrackReleasesResponse,
  EntityResolveResponse,
  LibrarySearchResponse,
  LookupResponse,
  StreamingCheckResponse,
} from '@wxyc/shared/dtos';

export type {
  DiscogsMatchResult,
  DiscogsReleaseMetadata,
  DiscogsTrackItem,
  DiscogsArtistCredit,
  DiscogsArtistDetails,
  DiscogsResolvedToken,
  DiscogsReleaseInfo,
  DiscogsTrackReleasesResponse,
  EntityResolveResponse,
  LibrarySearchItem,
  LibrarySearchResponse,
  LookupRequest,
  LookupResponse,
  LookupResultItem,
  StreamingCheckResponse,
  StreamingSourceMatch,
  StreamingCheckSources,
} from '@wxyc/shared/dtos';

class LmlClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'LmlClientError';
  }
}

export { LmlClientError };

// BS#873: matches `jobs/flowsheet-metadata-backfill/lml-fetch.ts` so the
// runtime path tolerates the same cold-cache LML cascade the backfill
// already accepts. Safe because every BS caller of /lookup runs
// fire-and-forget after the HTTP response is sent — a 30 s budget holds
// a Node promise + LML socket, not a user-visible request. Earlier 5 s
// budget was set when LML comfortably fit inside it; cold-cache
// compilations now land at 8-18 s (measured 2026-05-19, pre-A2/A3/A8
// promotion). The catch arm in `services/metadata/enrichment.service.ts`
// stamps the row with synthesized search URLs (sans
// `metadata_attempt_at`) so even a 30 s timeout doesn't leave a fully
// blank row for the listener.
const TIMEOUT_MS = 30000;

/**
 * Rate awareness of LML's Discogs ceilings (BS#906 / G4).
 *
 * LML's `/api/v1/lookup` fans out to Discogs on cache miss; its server-side
 * config caps Discogs at `discogs_max_concurrent=5` + `discogs_rate_limit=
 * 50/min`. When DJs add tracks in quick succession the BS fire-and-forget
 * fan-out can outrun those ceilings and pile up inside LML. Mirror the
 * ceilings on the client so the back-pressure shows up at our chokepoint,
 * not LML's. Defaults match LML's config; env-overridable so prod can
 * leave headroom for other LML callers (rom + tubafrenzy).
 *
 * Only the `/lookup` chokepoint is wrapped — the other LML endpoints
 * (release, artist, entity, track-releases, streaming-check, library/search)
 * are PG-cached and don't share the Discogs ceiling.
 *
 * When B4 (#887) extracts `@wxyc/lml-client`, this whole apparatus moves
 * with the client and stays the chokepoint for every consumer.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // Surface misconfigurations at startup so an operator who set `=0`
  // intending to disable the limiter sees their value was rejected
  // instead of silently falling back. A 0-permit semaphore would
  // deadlock, which is why we don't accept it.
  console.warn(`lml.client: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
}

/**
 * FIFO permit semaphore. acquire() resolves when a permit is available;
 * release() returns the permit to the next waiter (or restores it if no one
 * is waiting). queueDepth/availablePermits are read-only for observability.
 */
export class Semaphore {
  private permits: number;
  private readonly capacity: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
    this.capacity = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else if (this.permits < this.capacity) {
      this.permits += 1;
    }
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  get availablePermits(): number {
    return this.permits;
  }
}

/**
 * Continuous-refill token bucket. consume(n) resolves once n tokens have
 * been earned; until then the call sleeps for the shortest interval that
 * could earn the deficit. refillPerMinute matches LML's
 * discogs_rate_limit=50/min nomenclature so the env var name reads cleanly.
 */
export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor({ capacity, refillPerMinute }: { capacity: number; refillPerMinute: number }) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerMinute / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  async consume(count = 1): Promise<void> {
    // Loop the slow path. Without it, N callers can each compute the same
    // waitMs from an empty bucket, sleep for the same interval, wake
    // together, and all subtract `count` from the freshly refilled tokens
    // — overshooting the configured rate by ~N×. The loop re-checks the
    // bucket after each sleep so only the caller that finds enough tokens
    // proceeds; the others sleep again. Paired with the upstream FIFO
    // Semaphore, this preserves the configured rate under contention.
    while (true) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const deficit = count - this.tokens;
      const waitMs = Math.max(1, Math.ceil(deficit / this.refillPerMs));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Concurrency + rate-limit gate. Composes a `Semaphore` (max concurrent
 * in-flight) and a `TokenBucket` (call-rate ceiling) into a single
 * `run`-style chokepoint. Tokens are consumed inside the permit so wait time
 * on the bucket also holds a permit; tokens are NOT refunded on error — the
 * limiter caps attempted-call rate, not successful-call rate. Matches the
 * pattern from `apps/backend/services/lml/lml.client.ts:postLookup()` before
 * this package extraction, and is the same shape adopted by the backfill
 * (jobs/flowsheet-metadata-backfill/lml-limiter.ts) for BS#995.
 */
export interface LmlLimiter {
  /** Acquire a permit + a token, run fn, release the permit in finally. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Snapshot for tests + observability hooks (span attributes, metrics). */
  state(): { queueDepth: number; availablePermits: number; availableTokens: number };
}

/**
 * Compose a `Semaphore` + `TokenBucket` into a single `run`-style gate.
 * Pass explicit config in tests; in production the runtime path's
 * `defaultLimiter` reads from `LML_CLIENT_*` env vars, and per-surface
 * limiters (e.g. the backfill's stricter `BACKFILL_LML_*` defaults) wire
 * their own config at construction.
 */
export function createLmlLimiter(config: { maxConcurrent: number; ratePerMinute: number }): LmlLimiter {
  const semaphore = new Semaphore(config.maxConcurrent);
  const tokenBucket = new TokenBucket({ capacity: config.ratePerMinute, refillPerMinute: config.ratePerMinute });
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await semaphore.acquire();
      try {
        await tokenBucket.consume(1);
        return await fn();
      } finally {
        semaphore.release();
      }
    },
    state() {
      return {
        queueDepth: semaphore.queueDepth,
        availablePermits: semaphore.availablePermits,
        availableTokens: tokenBucket.availableTokens,
      };
    },
  };
}

/**
 * Runtime path's process-wide default limiter (BS#906 / G4). Reads
 * `LML_CLIENT_MAX_CONCURRENT` (default 5, mirrors LML's
 * `discogs_max_concurrent`) and `LML_CLIENT_RATE_PER_MIN` (default 50,
 * mirrors LML's `discogs_rate_limit`) at module load. The flowsheet-
 * metadata-backfill job constructs its own stricter limiter for BS#995 and
 * passes it via `LookupOptions.limiter`; that surface never shares this
 * default.
 */
let defaultLimiter: LmlLimiter;

function initDefaultLimiter(): void {
  defaultLimiter = createLmlLimiter({
    maxConcurrent: envInt('LML_CLIENT_MAX_CONCURRENT', 5),
    ratePerMinute: envInt('LML_CLIENT_RATE_PER_MIN', 50),
  });
}

initDefaultLimiter();

/** Number of /lookup calls currently waiting for a permit on the default limiter. */
export function getLmlQueueDepth(): number {
  return defaultLimiter.state().queueDepth;
}

/**
 * Test-only: reinitialize the default limiter against the current
 * `process.env` so a test that mutates env can exercise its effect.
 * Production code never calls this — the default limiter is intentionally
 * process-wide so concurrent /lookup calls share the same back-pressure.
 */
export function _resetLmlClientLimitersForTest(): void {
  initDefaultLimiter();
}

function getBaseUrl(): string {
  const url = process.env.LIBRARY_METADATA_URL;
  if (!url) {
    throw new LmlClientError('LIBRARY_METADATA_URL is not configured', 503);
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
}

async function lmlFetch(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  // Per-call override lets user-visible read paths (e.g. the rotation tracks
  // picker, BS#992) fast-fail at a tighter budget than the default 30 s,
  // freeing the LML semaphore permit sooner so other concurrent callers
  // don't queue behind a single hung Discogs round-trip. Defaults to
  // TIMEOUT_MS so existing fire-and-forget callers are unchanged.
  const effectiveTimeoutMs = timeoutMs ?? TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  // Merge LML_API_KEY bearer header at the single chokepoint. LML rolls auth
  // out gradually (LML_REQUIRE_AUTH defaults false on the server), so sending
  // the header before the flag flips is harmless.
  const apiKey = process.env.LML_API_KEY;
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new LmlClientError(
        `LML responded with ${response.status}: ${response.statusText}`,
        response.status >= 500 ? 502 : response.status
      );
    }

    return response;
  } catch (e) {
    if (e instanceof LmlClientError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new LmlClientError('LML request timed out', 504);
    }
    throw new LmlClientError(`LML request failed: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Optional flags accepted by LML's `/api/v1/lookup` since `@wxyc/shared@1.5.0`.
 *
 * - `extended`: surfaces additional fields on the top-1 `DiscogsMatchResult`
 *   (tracklist, genres, styles, label, full_release_date, discogs_artist_id,
 *   artist_image_url, profile_tokens). Use on the read path that already
 *   intends to consume those fields (e.g. the proxy/metadata/album collapse)
 *   so a single lookup replaces the follow-up release+artist fetches.
 *
 * - `warm_cache`: on the LML side, schedules a fire-and-forget background
 *   task that runs a deep async parse of the top-1 bio against the
 *   API-capable resolver, populating the PG cache for referenced entities.
 *   Use on the write path — DJ-flowsheet commit, rotation add — where a
 *   subsequent read for the same artist will benefit. Read-path callers
 *   leave this `false` to avoid amplifying Discogs API load.
 */
export interface LookupOptions {
  extended?: boolean;
  warm_cache?: boolean;
  /**
   * Per-call override for the LML fetch timeout (ms). Defaults to `TIMEOUT_MS`
   * (30 s) — appropriate for fire-and-forget enrichment paths where
   * thoroughness matters and a 30 s socket lifetime is cheap. Set lower for
   * user-visible request paths where fast-fail beats thoroughness; the
   * shorter budget also releases the LML semaphore permit sooner, reducing
   * head-of-line blocking on the shared chokepoint (BS#906 / BS#992).
   */
  timeoutMs?: number;
  /**
   * Per-call override for the rate-limit gate. Defaults to the module-level
   * runtime limiter (LML_CLIENT_MAX_CONCURRENT=5 / LML_CLIENT_RATE_PER_MIN=50).
   * Pass a surface-specific limiter (e.g. the backfill's stricter BACKFILL_LML_*
   * defaults from BS#995) to keep accounting separated and tunable per caller.
   */
  limiter?: LmlLimiter;
  /**
   * Caller-honored budget (ms) forwarded to LML as `X-Caller-Budget-Ms`
   * (WXYC/library-metadata-lookup#345). When set, LML short-circuits its
   * empty-results cascade once the budget elapses
   * (WXYC/library-metadata-lookup#403/#404) instead of burning Discogs quota
   * on a response the caller has already abandoned. Pair with `timeoutMs`:
   * set `budgetMs ~= timeoutMs - 1000` so LML's cutoff fires before the
   * fetch aborts, leaving room for transport + the LML response slack.
   * Omit to inherit LML's env soft budget (`LML_SEARCH_BUDGET_MS`, default
   * 4 s) which only fires when at least one prior strategy returned results
   * — the no-header path keeps the pre-A10 warm-cache / write-path semantics.
   */
  budgetMs?: number;
}

type LookupBody = {
  artist?: string;
  album?: string;
  song?: string;
  raw_message: string;
  extended?: boolean;
  warm_cache?: boolean;
};

/**
 * Look up a release in the library catalog via LML's full search pipeline.
 *
 * Provides artist correction, title normalization, fallback strategies,
 * artwork, streaming URLs, and artist metadata in a single call.
 *
 * @param artist - Artist name
 * @param album - Album/release title
 * @param song - Song/track title
 * @param options - Optional LML flags. See `LookupOptions`.
 * @returns Lookup results with library items and enriched artwork metadata
 */
export async function lookupMetadata(
  artist: string,
  album?: string,
  song?: string,
  options?: LookupOptions
): Promise<LookupResponse> {
  // LML's /lookup contract requires `raw_message` even when artist/album/song
  // are already structured. Synthesize a free-form description that the LML
  // parser would have produced — matches the e2e fixtures in LML's repo.
  const rawMessage = [artist, album, song].filter(Boolean).join(' - ');
  const body: LookupBody = { artist, raw_message: rawMessage };
  if (album) body.album = album;
  if (song) body.song = song;
  if (options?.extended) body.extended = true;
  if (options?.warm_cache) body.warm_cache = true;
  return postLookup(body, {
    timeoutMs: options?.timeoutMs,
    limiter: options?.limiter,
    budgetMs: options?.budgetMs,
  });
}

/**
 * Track-driven lookup: sends only `song` + `raw_message` (no artist field) so
 * LML's parser routes the request to its `SONG_AS_TRACK` strategy (LML#301),
 * which Discogs-cross-references the title and validates the track-on-release
 * before returning library matches. Used by the catalog Track-2 path
 * (BS#823) — Backend-Service is a thin proxy here; LML does all the ranking
 * and the response's `matched_via` carries the per-result evidence.
 */
export async function lookupBySong(
  song: string,
  options?: Pick<LookupOptions, 'limiter' | 'budgetMs'>
): Promise<LookupResponse> {
  return postLookup({ song, raw_message: song }, { limiter: options?.limiter, budgetMs: options?.budgetMs });
}

/**
 * Shared chokepoint for POST /api/v1/lookup. Wraps the call in a Sentry span
 * so the LML response's cache_stats (memory hits / pg hits / pg misses / api
 * calls / pg time / api time) lands as attributes on the BS transaction's
 * trace. Filterable in Sentry's trace explorer (e.g.
 * `lml.cache.api_calls > 0`) so per-callsite instrumentation isn't needed for
 * the metadata-backfill pilot or the runtime hot path. Sibling LML-side
 * projection at WXYC/library-metadata-lookup#213.
 */
async function postLookup(
  body: LookupBody,
  options?: { timeoutMs?: number; limiter?: LmlLimiter; budgetMs?: number }
): Promise<LookupResponse> {
  // BS#906 / G4: Mirror LML's Discogs ceilings on the client so back-pressure
  // surfaces at the BS chokepoint, not as queueing inside LML. The limiter
  // (`fn` runs after `semaphore.acquire()` + `tokenBucket.consume(1)`) keeps
  // queue-time outside the http.client span — span duration reflects fetch
  // work only.
  const activeLimiter = options?.limiter ?? defaultLimiter;
  return activeLimiter.run(async () => {
    return await Sentry.startSpan({ name: 'lml.lookup', op: 'http.client' }, async (span) => {
      try {
        span.setAttributes({ 'lml.queue_depth': activeLimiter.state().queueDepth });
      } catch (err) {
        console.warn('lml.client: failed to project queue_depth onto span', err);
      }

      // Only emit X-Caller-Budget-Ms when the caller set budgetMs — absent
      // header means LML keeps the pre-A10 safety branch for warm-cache /
      // write-path callers (WXYC/library-metadata-lookup#403/#404). Same
      // header-forwarding shape as `bulkLookupMetadata`.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options?.budgetMs !== undefined) {
        headers['X-Caller-Budget-Ms'] = String(options.budgetMs);
      }

      const response = await lmlFetch(
        '/api/v1/lookup',
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        options?.timeoutMs
      );

      const parsed = (await response.json()) as LookupResponse;

      // cache_stats schema is freeform today (additionalProperties: true). Until
      // wxyc-shared#86 tightens the type, treat it as a loose record and only
      // forward numeric fields onto the span. Narrow defensively to a real plain
      // object — Object.entries on a string/array would produce junk attributes
      // like lml.cache.0=...
      const stats = (parsed as { cache_stats?: unknown }).cache_stats;
      if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
        const attrs: Record<string, number> = {};
        for (const [key, value] of Object.entries(stats)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            attrs[`lml.cache.${key}`] = value;
          }
        }
        if (Object.keys(attrs).length > 0) {
          // Observability must never break the request path. If the Sentry SDK
          // (or a custom transport hook) throws, swallow the error and continue
          // — the lookup result is what callers depend on.
          try {
            span.setAttributes(attrs);
          } catch (err) {
            console.warn('lml.client: failed to project cache_stats onto span', err);
          }
        }
      }

      return parsed;
    });
  });
}

/**
 * One item in a bulk-lookup request. Mirrors LML's per-item `LookupRequest`
 * shape (artist/album/song optional + a synthesized `raw_message` required).
 * The caller assembles items — `bulkLookupMetadata` doesn't synthesize
 * `raw_message` itself because the album-level backfill (BS#1041) builds
 * items from DB joins where the artist/album fields are already structured.
 */
export interface BulkLookupItem {
  artist?: string;
  album?: string;
  song?: string;
  raw_message: string;
}

/**
 * Per-item verdict from the bulk-lookup endpoint (LML#368). Status is the
 * fast signal: `match` (`lookup.results` non-empty), `no_match` (search ran,
 * no rows), or `error` (per-item exception isolated from siblings).
 * `lookup` is null on error; `message` carries the error class on error.
 */
export interface BulkLookupResultItem {
  index: number;
  status: 'match' | 'no_match' | 'error';
  lookup: LookupResponse | null;
  message?: string;
}

export interface BulkLookupResponse {
  results: BulkLookupResultItem[];
}

/** LML's per-request hard cap on bulk items (kept in sync with `LML#368`). */
const BULK_LOOKUP_INPUT_CAP = 100;

/**
 * Bulk variant of `/api/v1/lookup`. LML's handler runs `perform_lookup` for
 * each item under a bounded asyncio Semaphore (`LML_BULK_MAX_CONCURRENT`,
 * default 10) and returns one verdict per input in input order. Per-item
 * failures land as `status: 'error'`; one item's failure can't poison the
 * batch.
 *
 * Wiring decisions:
 *
 * - **One limiter token per batch, not per item.** The LML endpoint already
 *   caps in-flight Discogs amplification internally; the BS-side limiter
 *   exists to mirror that same Discogs ceiling. Token-per-batch keeps the
 *   bulk caller from over-consuming the shared rate-limit pool.
 * - **`X-Caller-Budget-Ms` forwarded when `budgetMs` is set.** The LML route
 *   forwards the same value into each per-item `perform_lookup`'s
 *   `caller_budget_ms` arg (LML#345). Pairs with BS#1053 / LML#370 once the
 *   hard-cap follow-up lands — sending the header here is a no-op until then.
 * - **Span op mirrors `postLookup`** (`http.client`); `lml.bulk.size` is a
 *   bulk-specific attribute. `lml.cache.*` projection is byte-for-byte
 *   identical so existing Sentry queries (`lml.cache.api_calls > 0`, etc.)
 *   work without per-call refactors.
 *
 * Client-side validation rejects empty + oversize batches before the wire
 * call — a 422/400 round-trip costs an LML deploy slot and a TCP RTT for
 * no information gain.
 */
export async function bulkLookupMetadata(
  items: BulkLookupItem[],
  options?: { timeoutMs?: number; limiter?: LmlLimiter; budgetMs?: number }
): Promise<BulkLookupResponse> {
  if (items.length === 0) {
    throw new LmlClientError('bulkLookupMetadata requires at least 1 item.', 400);
  }
  if (items.length > BULK_LOOKUP_INPUT_CAP) {
    throw new LmlClientError(
      `bulkLookupMetadata exceeded the cap of ${BULK_LOOKUP_INPUT_CAP} items (received ${items.length}).`,
      400
    );
  }

  const activeLimiter = options?.limiter ?? defaultLimiter;
  return activeLimiter.run(async () => {
    return await Sentry.startSpan({ name: 'lml.lookup.bulk', op: 'http.client' }, async (span) => {
      try {
        span.setAttributes({
          'lml.queue_depth': activeLimiter.state().queueDepth,
          'lml.bulk.size': items.length,
        });
      } catch (err) {
        console.warn('lml.client: failed to project queue_depth + bulk.size onto span', err);
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options?.budgetMs !== undefined) {
        headers['X-Caller-Budget-Ms'] = String(options.budgetMs);
      }

      const response = await lmlFetch(
        '/api/v1/lookup/bulk',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ items }),
        },
        options?.timeoutMs
      );

      const parsed = (await response.json()) as BulkLookupResponse & { cache_stats?: unknown };

      // Same defensive cache_stats projection as postLookup (line ~463).
      // LML aggregates the in-process cache counters across the whole batch
      // via a single `init_cache_stats()` at the route top, so one set of
      // attributes per bulk call is correct.
      const stats = parsed.cache_stats;
      if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
        const attrs: Record<string, number> = {};
        for (const [key, value] of Object.entries(stats)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            attrs[`lml.cache.${key}`] = value;
          }
        }
        if (Object.keys(attrs).length > 0) {
          try {
            span.setAttributes(attrs);
          } catch (err) {
            console.warn('lml.client: failed to project cache_stats onto bulk span', err);
          }
        }
      }

      return { results: parsed.results };
    });
  });
}

/**
 * Get full release metadata from LML.
 *
 * @param releaseId - Discogs release ID
 * @returns Release metadata including tracklist, genres, styles
 */
export async function getRelease(releaseId: number): Promise<DiscogsReleaseMetadata> {
  const response = await lmlFetch(`/api/v1/discogs/release/${releaseId}`);
  return (await response.json()) as DiscogsReleaseMetadata;
}

/**
 * Get artist details from LML.
 *
 * @param artistId - Discogs artist ID
 * @returns Artist details including bio, image, URLs
 */
export async function getArtistDetails(artistId: number): Promise<DiscogsArtistDetails> {
  const response = await lmlFetch(`/api/v1/discogs/artist/${artistId}`);
  return (await response.json()) as DiscogsArtistDetails;
}

/**
 * Resolve a Discogs entity (artist, release, or master) to its name.
 *
 * @param type - Entity type: artist, release, or master
 * @param id - Discogs entity ID
 * @returns Entity name and basic info
 */
export async function resolveEntity(type: 'artist' | 'release' | 'master', id: number): Promise<EntityResolveResponse> {
  const response = await lmlFetch(`/api/v1/discogs/entity/${type}/${id}`);
  return (await response.json()) as EntityResolveResponse;
}

/**
 * Search for all releases containing a track via LML.
 *
 * @param track - Track/song title to search for
 * @param artist - Optional artist name for filtering
 * @param limit - Maximum number of results (default 20)
 * @returns List of releases containing the track
 */
export async function searchTrackReleases(
  track: string,
  artist?: string,
  limit = 20
): Promise<DiscogsTrackReleasesResponse> {
  const params = new URLSearchParams({ track });
  if (artist) params.set('artist', artist);
  if (limit !== 20) params.set('limit', String(limit));

  const response = await lmlFetch(`/api/v1/discogs/track-releases?${params}`);
  return (await response.json()) as DiscogsTrackReleasesResponse;
}

/**
 * Validate that a track by an artist exists on a release.
 *
 * Fetches the full release from LML and checks the tracklist client-side.
 * Uses case-insensitive substring matching on track title and artist name.
 *
 * @param releaseId - Discogs release ID
 * @param track - Track title to find
 * @param artist - Artist name to find
 * @returns true if the track by the artist is found on the release
 */
export async function validateTrackOnRelease(releaseId: number, track: string, artist: string): Promise<boolean> {
  const release = await getRelease(releaseId);

  const trackLower = track.toLowerCase();
  const artistLower = artist.toLowerCase();

  for (const item of release.tracklist) {
    const itemTitle = item.title.toLowerCase();

    // Check if track title matches (substring in either direction)
    if (!trackLower.includes(itemTitle) && !itemTitle.includes(trackLower)) {
      continue;
    }

    // Check per-track artists first (for compilations)
    if (item.artists.length > 0) {
      for (const trackArtist of item.artists) {
        const normalized = trackArtist.toLowerCase().split('(')[0].trim();
        if (artistLower.includes(normalized) || normalized.includes(artistLower)) {
          return true;
        }
      }
      continue;
    }

    // Fall back to release-level artist (strip Discogs numbering like "(2)")
    const releaseArtist = release.artist.toLowerCase().split('(')[0].trim();
    if (artistLower.includes(releaseArtist) || releaseArtist.includes(artistLower)) {
      return true;
    }
  }

  return false;
}

/**
 * Check streaming availability for an artist+title pair.
 *
 * @param artist - Artist name
 * @param title - Album title
 * @returns Streaming availability result with per-source URLs
 */
export async function checkStreamingAvailability(artist: string, title: string): Promise<StreamingCheckResponse> {
  const response = await lmlFetch('/api/v1/streaming-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artist, title }),
  });

  return (await response.json()) as StreamingCheckResponse;
}

/**
 * Search the library catalog via LML.
 *
 * @param params - Search parameters (artist, title, q, limit)
 * @returns Library search results
 */
export async function searchLibrary(params: {
  artist?: string;
  title?: string;
  q?: string;
  limit?: number;
}): Promise<LibrarySearchResponse> {
  const searchParams = new URLSearchParams();
  if (params.artist) searchParams.set('artist', params.artist);
  if (params.title) searchParams.set('title', params.title);
  if (params.q) searchParams.set('q', params.q);
  if (params.limit) searchParams.set('limit', String(params.limit));

  const response = await lmlFetch(`/api/v1/library/search?${searchParams}`);
  return (await response.json()) as LibrarySearchResponse;
}

/**
 * Check whether the LML service is configured.
 */
export function isLmlConfigured(): boolean {
  return !!process.env.LIBRARY_METADATA_URL;
}
