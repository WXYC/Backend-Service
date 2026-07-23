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
  DiscogsWriterCredits,
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

// BS#1710: streaming-URL host guard. Enforces "a `spotify_url` field must
// hold a Spotify URL" (and the Apple analogue) at the LML response boundary
// — `sanitizeLookupStreamingUrls` is applied in `postLookup` +
// `bulkLookupMetadata` below so every downstream writer + serve seam is
// covered at one chokepoint. Imported (not just re-exported) so it's in
// local scope for those callsites.
import { isSpotifyUrl, isAppleMusicUrl, sanitizeLookupStreamingUrls } from './streaming-url-guard.js';
export { isSpotifyUrl, isAppleMusicUrl, sanitizeLookupStreamingUrls };

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
 * This is the runtime-lookup chokepoint: `lookupMetadata` + `bulkLookupMetadata`
 * (both funnel through `postLookup`) — the string-resolve surface that can
 * produce false Discogs matches, and therefore the surface the BS#1293
 * `discogsUnavailable` gate covers (`LookupOptions.discogsUnavailable` /
 * `BulkLookupItem.discogsUnavailable` below). A handful of other exports
 * (`resolveArtistNamesBulk`, `fetchArtistGenresBulk`, `checkStreamingAvailability`)
 * also share this Semaphore/TokenBucket pair for Discogs back-pressure but are
 * NOT part of the discogsUnavailable gate — they don't resolve a free-text
 * artist/album pair against a possibly-flagged catalog row. The remaining
 * LML-touching exports (`getRelease`, `getArtistDetails`, `resolveEntity`,
 * `searchTrackReleases`, `validateTrackOnRelease`, `searchLibrary`) call
 * PG-cached endpoints and share neither the limiter nor the gate.
 *
 * When B4 (#887) extracts `@wxyc/lml-client`, this whole apparatus moves
 * with the client and stays the chokepoint for every consumer.
 */

/**
 * Read a positive-integer env var with a fallback. Empty string and undefined
 * map to the fallback; `0`, negative, and non-numeric values trigger a startup
 * warn and also fall back — silently shipping `NaN`/`0` to downstream consumers
 * (a semaphore-permit count, a budget header, etc.) is the failure mode this
 * guards against.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
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

/**
 * Caller-honored LML budget header (WXYC/library-metadata-lookup#345). When
 * present, LML short-circuits its empty-results cascade once the budget
 * elapses (WXYC/library-metadata-lookup#403/#404). Emitted by `postLookup`
 * and `bulkLookupMetadata` when the caller sets `options.budgetMs`.
 */
const CALLER_BUDGET_HEADER = 'X-Caller-Budget-Ms';

/**
 * Build the request headers for a `/lookup` or `/lookup/bulk` POST. Returns a
 * fresh object so callers can safely mutate. `budgetMs` becomes the
 * `CALLER_BUDGET_HEADER` value when set; absent budget means no header (LML
 * keeps the pre-A10 safety branch).
 */
function buildLookupHeaders(budgetMs?: number): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (budgetMs !== undefined) {
    headers[CALLER_BUDGET_HEADER] = String(budgetMs);
  }
  return headers;
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
  /**
   * Caller-class label projected onto the Sentry `lml.lookup` span as the
   * `lml.caller` attribute (BS#1235). Used to slice the rolled-up p95 in
   * Sentry's trace explorer (and the Epic A acceptance routine at
   * WXYC/library-metadata-lookup#338) so interactive paths
   * (proxy/library/rotation, ~5 s budget) and background paths
   * (enrichment-worker, ~29 s budget) don't fight each other in the rollup.
   * Lowercase kebab-case scoped to the call site (e.g. `proxy-album-metadata`,
   * `enrichment-worker`, `library-track-search`). Omit at your peril — missing
   * callers project as `lml.caller=unknown`, which is meant as a Sentry
   * flag-of-shame so untracked call sites surface in queries.
   */
  caller?: string;
  /**
   * BS#1293 runtime-lookup gate. When `true` and `forceLookup` is not also
   * `true`, `lookupMetadata` short-circuits before acquiring a limiter permit
   * or a token: no LML call is made, no `Semaphore`/`TokenBucket` accounting
   * happens, and the caller gets back a `GatedLookupResponse` with
   * `outcome: 'skipped_discogs_unavailable'` — a `LookupResponse`-shaped empty
   * result plus the discriminator. Callers set this from a pre-read of
   * `library.discogs_unavailable` (BS#1281); the gate itself does not query
   * the database. See the "runtime-lookup chokepoint" doc above for scope.
   */
  discogsUnavailable?: boolean;
  /**
   * Overrides `discogsUnavailable`, forcing the lookup through as normal.
   * Used by the discogsUnavailable recheck cron (sub-issue 3, BS#1294) so it
   * can re-ask LML for a target previously flagged unavailable without a
   * caller-side handshake that flips `discogsUnavailable` itself (self-review
   * flagged that as refactor-fragile). No effect when `discogsUnavailable`
   * is not `true`.
   */
  forceLookup?: boolean;
}

/** Discriminator for a runtime-lookup call the BS#1293 gate short-circuited. */
export type LookupSkippedOutcome = 'skipped_discogs_unavailable';

/**
 * `LookupResponse` extended with an optional `outcome` discriminator
 * (BS#1293). Present only when the runtime-lookup gate skipped the call
 * (`discogsUnavailable: true` + no `forceLookup`); absent on every real LML
 * response, so existing consumers that only read the base `LookupResponse`
 * fields (`results`, `search_type`, etc.) are unaffected.
 */
export interface GatedLookupResponse extends LookupResponse {
  outcome?: LookupSkippedOutcome;
}

/** Sentry `lml.lookup.skipped_reason` value stamped by the BS#1293 gate. */
const DISCOGS_UNAVAILABLE_SKIPPED_REASON = 'discogs_unavailable';

/**
 * Builds the `LookupResponse`-shaped skipped outcome the BS#1293 gate
 * returns in place of a real LML call — the same required fields a genuine
 * empty result would carry (`results: []`, `search_type: 'none'`, …) plus
 * the `outcome` discriminator so a caller can tell "asked LML, got nothing"
 * apart from "never asked."
 */
function buildSkippedLookupResponse(): GatedLookupResponse {
  return {
    results: [],
    search_type: 'none',
    song_not_found: false,
    found_on_compilation: false,
    timeout: false,
    outcome: 'skipped_discogs_unavailable',
  };
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
  artist: string | undefined,
  album?: string,
  song?: string,
  options?: LookupOptions
): Promise<GatedLookupResponse> {
  // LML's /lookup contract requires `raw_message` even when artist/album/song
  // are already structured. Synthesize a free-form description that the LML
  // parser would have produced — matches the e2e fixtures in LML's repo.
  const rawMessage = [artist, album, song].filter(Boolean).join(' - ');
  // `artist` is optional so callers can opt out of artist-side disambiguation
  // when they know the artist field would poison the match (e.g. the rotation
  // picker for Various-Artists releases — LML's parser does better with the
  // album-only path than with "Various Artists" as a literal artist).
  const body: LookupBody = { raw_message: rawMessage };
  if (artist) body.artist = artist;
  if (album) body.album = album;
  if (song) body.song = song;
  if (options?.extended) body.extended = true;
  if (options?.warm_cache) body.warm_cache = true;
  return postLookup(body, {
    timeoutMs: options?.timeoutMs,
    limiter: options?.limiter,
    budgetMs: options?.budgetMs,
    caller: options?.caller,
    discogsUnavailable: options?.discogsUnavailable,
    forceLookup: options?.forceLookup,
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
  options?: Pick<LookupOptions, 'limiter' | 'budgetMs' | 'caller'>
): Promise<LookupResponse> {
  return postLookup(
    { song, raw_message: song },
    { limiter: options?.limiter, budgetMs: options?.budgetMs, caller: options?.caller }
  );
}

/**
 * Shared chokepoint for POST /api/v1/lookup. Wraps the call in a Sentry span
 * so the LML response's cache_stats (memory hits / pg hits / pg misses / api
 * calls / pg time / api time) lands as attributes on the BS transaction's
 * trace. Filterable in Sentry's trace explorer (e.g.
 * `lml.cache.api_calls > 0`) so per-callsite instrumentation isn't needed for
 * the metadata-backfill pilot or the runtime hot path. Sibling LML-side
 * projection at WXYC/library-metadata-lookup#213.
 *
 * BS#1293: the `discogsUnavailable` gate short-circuits here, before the
 * limiter is touched — a gated call consumes no `Semaphore` permit and no
 * `TokenBucket` token, because the lookup never happens.
 */
async function postLookup(
  body: LookupBody,
  options?: {
    timeoutMs?: number;
    limiter?: LmlLimiter;
    budgetMs?: number;
    caller?: string;
    discogsUnavailable?: boolean;
    forceLookup?: boolean;
  }
): Promise<GatedLookupResponse> {
  if (options?.discogsUnavailable && !options?.forceLookup) {
    return Sentry.startSpan({ name: 'lml.lookup', op: 'lml.lookup.skipped' }, async (span) => {
      try {
        span.setAttributes({
          'lml.lookup.skipped_reason': DISCOGS_UNAVAILABLE_SKIPPED_REASON,
          'lml.caller': options?.caller ?? 'unknown',
        });
      } catch (err) {
        console.warn('lml.client: failed to project skipped_reason + caller onto span', err);
      }
      return buildSkippedLookupResponse();
    });
  }

  // BS#906 / G4: Mirror LML's Discogs ceilings on the client so back-pressure
  // surfaces at the BS chokepoint, not as queueing inside LML. The limiter
  // (`fn` runs after `semaphore.acquire()` + `tokenBucket.consume(1)`) keeps
  // queue-time outside the http.client span — span duration reflects fetch
  // work only.
  const activeLimiter = options?.limiter ?? defaultLimiter;
  return activeLimiter.run(async () => {
    return await Sentry.startSpan({ name: 'lml.lookup', op: 'http.client' }, async (span) => {
      try {
        span.setAttributes({
          'lml.queue_depth': activeLimiter.state().queueDepth,
          'lml.caller': options?.caller ?? 'unknown',
        });
      } catch (err) {
        console.warn('lml.client: failed to project queue_depth + caller onto span', err);
      }

      const response = await lmlFetch(
        '/api/v1/lookup',
        {
          method: 'POST',
          headers: buildLookupHeaders(options?.budgetMs),
          body: JSON.stringify(body),
        },
        options?.timeoutMs
      );

      // BS#1710: enforce the streaming-URL host invariant at this untrusted
      // boundary. LML's `artwork.spotify_url` can carry a non-Spotify URL
      // (Deezer/Apple/…) sourced from the library `streaming_links` artifact;
      // null it here so no downstream writer persists it under the Spotify
      // slot and the writers' `?? searchUrls.spotify_url` fallback wins.
      const parsed = sanitizeLookupStreamingUrls((await response.json()) as LookupResponse);

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
  /**
   * Surfaces the 8 extended-only `DiscogsMatchResult` fields (genres/styles/
   * tracklist/label/full_release_date/discogs_artist_id/artist_image_url/
   * profile_tokens) on the item's top-1 artwork block. Honored per-item on the
   * bulk path (LML#685), where it is CACHE-ONLY — it reads from data the
   * per-item lookup already fetched, adding zero incremental Discogs calls. The
   * CDC enrichment worker (BS#1749) sets this so its BS#1336 album_metadata
   * columns survive the batch, matching the per-row `lookupMetadata` path.
   */
  extended?: boolean;
  /**
   * BS#1293 runtime-lookup gate, bulk-item form. When `true`, this item is
   * pulled out of the wire request entirely — it is never sent to LML, never
   * charges the shared limiter — and its slot in `BulkLookupResponse.results`
   * comes back as `{ status: 'skipped_discogs_unavailable', lookup: {
   * outcome: 'skipped_discogs_unavailable', ... } }`. Sibling items without
   * the flag are unaffected and still batch together in one LML call. There
   * is no per-item `forceLookup` override (unlike `lookupMetadata`) — the
   * caller decides which items to flag at construction time.
   */
  discogsUnavailable?: boolean;
}

/**
 * Per-item verdict from the bulk-lookup endpoint (LML#368). Status is the
 * fast signal: `match` (`lookup.results` non-empty), `no_match` (search ran,
 * no rows), `error` (per-item exception isolated from siblings), or
 * `skipped_discogs_unavailable` (BS#1293 — the item never reached LML because
 * its `discogsUnavailable` flag was set). `lookup` is null on error; on a skip
 * it is the same `GatedLookupResponse` shape `lookupMetadata`'s single-item
 * gate returns. `message` carries the error class on error.
 */
export interface BulkLookupResultItem {
  index: number;
  status: 'match' | 'no_match' | 'error' | LookupSkippedOutcome;
  lookup: GatedLookupResponse | null;
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
 *
 * BS#1293: items with `discogsUnavailable: true` are filtered out of the wire
 * request before it's built — LML never sees them, and if every item in the
 * batch is flagged, no HTTP call is made at all (no limiter/token spend
 * either). Skipped items are spliced back into `results` at their original
 * index so the response stays index-aligned with the caller's input, matching
 * the non-gated contract.
 */
export async function bulkLookupMetadata(
  items: BulkLookupItem[],
  options?: { timeoutMs?: number; limiter?: LmlLimiter; budgetMs?: number; caller?: string }
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

  const skippedIndices = new Set<number>();
  items.forEach((item, index) => {
    if (item.discogsUnavailable) skippedIndices.add(index);
  });
  // Wire body must not carry the BS-local `discogsUnavailable` flag — strip it
  // even from sent items so a stray `false` doesn't reach LML's schema.
  const sendItems = items
    .filter((item) => !item.discogsUnavailable)
    .map(({ discogsUnavailable: _discogsUnavailable, ...wireItem }) => wireItem);

  // Every item flagged: skip the wire call entirely, same gate as the
  // single-item path — no limiter/token spend, no fetch.
  if (sendItems.length === 0) {
    return Sentry.startSpan({ name: 'lml.lookup.bulk', op: 'lml.lookup.skipped' }, async (span) => {
      try {
        span.setAttributes({
          'lml.bulk.size': items.length,
          'lml.lookup.skipped_reason': DISCOGS_UNAVAILABLE_SKIPPED_REASON,
          'lml.caller': options?.caller ?? 'unknown',
        });
      } catch (err) {
        console.warn('lml.client: failed to project bulk.size + skipped_reason + caller onto span', err);
      }
      return { results: items.map((_, index) => buildSkippedBulkResultItem(index)) };
    });
  }

  const activeLimiter = options?.limiter ?? defaultLimiter;
  return activeLimiter.run(async () => {
    return await Sentry.startSpan({ name: 'lml.lookup.bulk', op: 'http.client' }, async (span) => {
      try {
        span.setAttributes({
          'lml.queue_depth': activeLimiter.state().queueDepth,
          'lml.bulk.size': items.length,
          'lml.caller': options?.caller ?? 'unknown',
        });
      } catch (err) {
        console.warn('lml.client: failed to project queue_depth + bulk.size + caller onto span', err);
      }

      const response = await lmlFetch(
        '/api/v1/lookup/bulk',
        {
          method: 'POST',
          headers: buildLookupHeaders(options?.budgetMs),
          body: JSON.stringify({ items: sendItems }),
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

      // BS#1710: same streaming-URL host invariant as postLookup, applied to
      // each per-item verdict's nested LookupResponse (null on `status: error`).
      for (const item of parsed.results ?? []) {
        if (item.lookup != null) sanitizeLookupStreamingUrls(item.lookup);
      }

      // BS#1293: splice the synthetic skipped verdicts back in at their
      // original positions and reindex the real verdicts (which LML returned
      // aligned to `sendItems`, not the caller's original `items`) so the
      // final array is index-aligned with the caller's input in input order.
      let sentCursor = 0;
      const results = items.map((_, index) => {
        if (skippedIndices.has(index)) {
          return buildSkippedBulkResultItem(index);
        }
        const sentResult = parsed.results[sentCursor];
        sentCursor += 1;
        return { ...sentResult, index };
      });

      return { results };
    });
  });
}

/**
 * Synthetic `BulkLookupResultItem` for a BS#1293-gated bulk item — same
 * shape a real skip produces on the single-item path, indexed to the item's
 * original position in the caller's input array.
 */
function buildSkippedBulkResultItem(index: number): BulkLookupResultItem {
  return {
    index,
    status: 'skipped_discogs_unavailable',
    lookup: buildSkippedLookupResponse(),
  };
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
  // BS#1750 / B5: fires on every album add. Route it through the process-wide
  // `defaultLimiter` — the same shared concurrency/rate gate as `/lookup` —
  // so this call participates in the admission budget instead of being an
  // ungoverned direct call that could overrun LML's real concurrency ceiling
  // alongside the enrichment/backfill limiters. The fetch runs after the
  // limiter's `semaphore.acquire()` + `tokenBucket.consume(1)`; the permit is
  // released in the limiter's `finally`. Behavior is otherwise unchanged —
  // same path, headers, body, and returned `StreamingCheckResponse`.
  return defaultLimiter.run(async () => {
    const response = await lmlFetch('/api/v1/streaming-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist, title }),
    });

    return (await response.json()) as StreamingCheckResponse;
  });
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
 * Wire shape for `POST /api/v1/identity/resolve` (LML#526, BS#1380).
 *
 * Mirrors `ReleaseIdentityResolveRequest` / `ReleaseIdentityResolveResponse`
 * in `wxyc-shared/api.yaml`. Defined locally rather than imported from
 * `@wxyc/shared/dtos` so this wrapper compiles against the currently-shipped
 * shared bundle; the types move to `@wxyc/shared/dtos` once the OpenAPI
 * codegen catches up. Same approach used by the original `EntityResolveResponse`
 * during its own ramp-up.
 *
 * v1 accepts only `kind: 'release'`; `kind: 'artist'` is reserved for the
 * symmetric extension.
 */
export type ReleaseIdentityResolveSource = 'discogs_release' | 'discogs_master' | 'bandcamp';

export interface ReleaseIdentityResolveRequest {
  kind: 'release';
  source: ReleaseIdentityResolveSource;
  /**
   * Source-specific identifier. For `discogs_release` / `discogs_master` it
   * is the positive integer ID as a string; zero / negative values are
   * rejected with 422 (Discogs uses `0` for the unknown-release sentinel).
   * For `bandcamp` it is the canonical album URL.
   */
  external_id: string;
}

export interface ReleaseIdentityResolveResponse {
  /** Stable `entity.release_identity.id` for the resolved row. */
  identity_id: number;
  kind: 'release';
  /** `true` when this call inserted a new identity row; `false` on re-resolve. */
  minted: boolean;
}

/**
 * BS#1380: default timeout for `resolveIdentity`. The dj-site `addToRotation`
 * path awaits this synchronously inside the Express handler before INSERT,
 * so the budget gates user-perceived latency. 2 s matches the user-visible
 * read paths (BS#992 picker budget) and is the value the BS#1380 plan
 * commits to in prose; the catch path falls back to NULL on timeout and the
 * daily backfill cron catches up within ~24h.
 */
const RESOLVE_IDENTITY_TIMEOUT_MS = 2000;

/**
 * Resolve a release-shaped `(source, external_id)` pair to a stable
 * `entity.release_identity.id` on the LML side (LML#526).
 *
 * Idempotent on `(source, external_id)`: the same triple always returns
 * the same `identity_id`. First call mints (`minted: true`), subsequent
 * calls return the existing row (`minted: false`).
 *
 * The default timeout (`LML_RESOLVE_TIMEOUT_MS`, fallback 2000 ms) is set
 * at the wrapper layer rather than at each caller — every consumer (BS's
 * `addToRotation`, the `rotation-lml-identity-backfill` cron) wants the
 * same fast-fail semantics. Pass an explicit `timeoutMs` to override.
 *
 * Errors:
 *   - Timeout: `LmlClientError('LML request timed out', 504)` (rethrown
 *     from `lmlFetch`). Caller categorises the AbortError as `'timeout'`
 *     in its Sentry counter.
 *   - 5xx: `LmlClientError(..., 502)` (the upstream status is rolled
 *     into the LML client's "treat as bad gateway" wrapper).
 *   - 4xx (incl. 422 sentinel rejection): `LmlClientError(..., status)`.
 *   - Network: `LmlClientError(..., 502)` after the fetch throws.
 */
export async function resolveIdentity(
  request: ReleaseIdentityResolveRequest,
  options?: { timeoutMs?: number }
): Promise<ReleaseIdentityResolveResponse> {
  const timeoutMs = options?.timeoutMs ?? envInt('LML_RESOLVE_TIMEOUT_MS', RESOLVE_IDENTITY_TIMEOUT_MS);
  const response = await lmlFetch(
    '/api/v1/identity/resolve',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    timeoutMs
  );
  return (await response.json()) as ReleaseIdentityResolveResponse;
}

/**
 * Wire shape for `POST /api/v1/cache/refresh-for-identities` (LML#525, BS#1381).
 *
 * Mirrors `BulkCacheRefreshRequest` / `BulkCacheRefreshResponse` in
 * `wxyc-shared/api.yaml`. Defined locally rather than imported from
 * `@wxyc/shared/dtos` so this wrapper compiles against the currently-shipped
 * shared bundle; the types move to `@wxyc/shared/dtos` once the OpenAPI
 * codegen catches up. Same pattern used by `EntityResolveResponse` and
 * `ReleaseIdentityResolveResponse` during their own ramp-ups.
 *
 * Per-id `status` rollup is release-leg-gated by LML:
 *   - `warmed`           — at least one source's release_outcome was `success`.
 *                          Cache hits, fresh fetches, AND tombstones (LML#510)
 *                          all count — the cache state is current either way.
 *   - `not_found`        — no row in `entity.release_identity` for this id.
 *                          BS holds a stale `lml_identity_id` reference.
 *   - `not_implemented`  — at least one source returned `not_implemented`,
 *                          no source was `success` (e.g. discogs_master,
 *                          MusicBrainz pre-LML#217).
 *   - `error`            — all dispatched sources errored. The only retry
 *                          signal.
 */
export type CacheRefreshSourceOutcome = 'success' | 'error' | 'not_implemented';
export type CacheRefreshItemStatus = 'warmed' | 'not_found' | 'not_implemented' | 'error';

export interface CacheRefreshArtistOutcome {
  /** String-typed for future source-agnosticism — Discogs IDs serialize as decimal strings. */
  external_id: string;
  outcome: CacheRefreshSourceOutcome;
  /** Exception class name when `outcome != success`. Full traceback lands in LML's Sentry. */
  message?: string | null;
}

export interface CacheRefreshSourceResult {
  release_outcome: CacheRefreshSourceOutcome;
  /** Walk-to-artists fan-out result. Empty on tombstone-success and on non-Discogs legs. */
  artists?: CacheRefreshArtistOutcome[];
  message?: string | null;
}

export interface CacheRefreshResultItem {
  identity_id: number;
  status: CacheRefreshItemStatus;
  /** Null when `status === 'not_found'`. Otherwise keyed by source vocabulary (`discogs_release`, …). */
  sources?: Record<string, CacheRefreshSourceResult> | null;
  message?: string | null;
}

export interface BulkCacheRefreshRequest {
  identity_ids: number[];
}

export interface BulkCacheRefreshResponse {
  /** Per-identity verdicts in input order. No top-level counters — callers derive. */
  results: CacheRefreshResultItem[];
}

/**
 * Per-request cap on `refreshForIdentities`. LML returns 400 on overflow —
 * the cap is bounded by Discogs rate-limit × cold-cache fan-out ≤ Railway's
 * request-timeout ceiling. Exported so consumers can chunk inputs against
 * the same constant instead of redefining it. Hard contract, not a tunable.
 */
export const REFRESH_FOR_IDENTITIES_BATCH_CAP = 50;

/**
 * Refresh LML's cache for a batch of release `identity_id`s (LML#525).
 *
 * LML maps each id to its per-source `(source, external_id)` pairs, dispatches
 * the per-source release-cache refresh, and walks each refreshed Discogs
 * release's artist credits to refresh artist caches too. Multiplexes onto
 * the existing fallthrough seam (LML#503's `fetched_at` discriminator) —
 * already-warm cache rows don't re-hit Discogs.
 *
 * Per-request cap: **50 identity_ids** (`REFRESH_FOR_IDENTITIES_BATCH_CAP`).
 * The wrapper defends against under- and over-cap inputs client-side so a
 * misconfigured caller fails fast instead of burning a wire round-trip on
 * an LML 400.
 *
 * Default timeout matches the shared `TIMEOUT_MS` (30 s). Consumers whose
 * batches can run cold-cache (Discogs fan-out × per-call latency) should
 * pass a longer `timeoutMs` so a successful LML writeback isn't misclassified
 * as a transport error on first touch.
 */
export async function refreshForIdentities(
  identityIds: number[],
  options?: { timeoutMs?: number }
): Promise<BulkCacheRefreshResponse> {
  if (identityIds.length === 0) {
    throw new LmlClientError('refreshForIdentities requires at least one identity_id', 400);
  }
  if (identityIds.length > REFRESH_FOR_IDENTITIES_BATCH_CAP) {
    throw new LmlClientError(
      `refreshForIdentities batch size ${identityIds.length} exceeds the ${REFRESH_FOR_IDENTITIES_BATCH_CAP}-id cap; chunk upstream`,
      400
    );
  }
  const response = await lmlFetch(
    '/api/v1/cache/refresh-for-identities',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity_ids: identityIds } satisfies BulkCacheRefreshRequest),
    },
    options?.timeoutMs
  );
  return (await response.json()) as BulkCacheRefreshResponse;
}

/**
 * Wire shape for `POST /api/v1/artists/resolve/bulk` (LML#759, BS#1614).
 *
 * Mirrors `ArtistResolveBulkRequest` / `ArtistResolveBulkResponse` /
 * `ArtistResolveResult` and the three verdict enums in `wxyc-shared/api.yaml`
 * (PR A, wxyc-shared#218). Defined locally rather than imported from
 * `@wxyc/shared/dtos` so this wrapper compiles against the currently-shipped
 * shared bundle; the types move to `@wxyc/shared/dtos` once the OpenAPI codegen
 * catches up. Same pattern used by `EntityResolveResponse`,
 * `ReleaseIdentityResolveRequest`, and `BulkCacheRefreshRequest` during their
 * own ramp-ups.
 *
 * Resolution model is verify-before-mint: `method` has exactly two values
 * because the discogs-cache is a pair-wise-filtered sample of Discogs — cache
 * legs corroborate (and equality legs can veto a mint into `ambiguous`) but
 * never decide. `escalation_unavailable` is the one RETRYABLE unresolved reason
 * ("couldn't ask," not "asked and missed"); consumers must not apply a no-match
 * TTL to it.
 */

/** What decided a resolved verdict: an `identity_store` short-circuit vs a live `api_search`. */
export type ArtistResolveMethod = 'identity_store' | 'api_search';

/**
 * A discogs-cache candidate-generation leg that produced >= 1 candidate for the
 * input's identity-match form. Corroboration + conflict detection only, never a
 * verdict: the four equality legs can veto a mint into `ambiguous`; fuzzy
 * `cache_trigram` neighbors never veto.
 */
export type ArtistResolveCacheLeg =
  'cache_exact' | 'cache_member' | 'cache_alias' | 'cache_name_variation' | 'cache_trigram';

/**
 * Why a name did not resolve. `not_found` / `ambiguous` are terminal;
 * `escalation_unavailable` (breaker open / outage / 429 / 5xx-after-retries) is
 * RETRYABLE — the caller must not stamp a no-match TTL on it.
 */
export type ArtistResolveUnresolvedReason = 'not_found' | 'ambiguous' | 'escalation_unavailable';

/**
 * Verdict for one input name, index-aligned with the request's `names`. Exactly
 * one of `discogs_artist_id` (resolved) or `unresolved_reason` is present;
 * `cache_corroboration` is always present (may be empty). `candidate_count` is
 * always serialized — `null` means "not measured" (the API tier did not run:
 * identity_store short-circuit or escalation_unavailable), never zero-as-unknown.
 */
export interface ArtistResolveResult {
  /** Verbatim echo of the input name at this index. */
  name: string;
  /** The resolved Discogs artist id. Present iff resolved. */
  discogs_artist_id?: number;
  /**
   * Raw Discogs artist title, disambiguation suffix included (e.g. `Popsicle (2)`).
   * Present iff resolved via `api_search` — `identity_store` rows store no title.
   */
  canonical_name?: string;
  /** What decided the resolution. Present iff resolved. */
  method?: ArtistResolveMethod;
  /**
   * Cache legs that produced candidates for this name's identity-match form, on
   * both verdict kinds. Empty when no leg produced candidates and always empty
   * on `identity_store` short-circuits.
   */
  cache_corroboration: ArtistResolveCacheLeg[];
  /** Why the name did not resolve. Present iff unresolved. */
  unresolved_reason?: ArtistResolveUnresolvedReason;
  /**
   * Exact-form candidates the API tier observed (1 on resolved, 0 on
   * not_found; on ambiguous >= 2 for an overloaded family or exactly 1 for an
   * equality-leg cache conflict). `null` when the API tier did not run.
   */
  candidate_count: number | null;
}

export interface ArtistResolveBulkRequest {
  names: string[];
  /** Run every tier identically but skip the `entity.identity` write-back. */
  dry_run?: boolean;
}

export interface ArtistResolveBulkResponse {
  /** One verdict per input name, in input order. */
  results: ArtistResolveResult[];
}

/**
 * LML's per-request hard cap on `resolveArtistNamesBulk` (LML#759). Keeps a
 * fully-escalating batch within the shared 50/min Discogs budget (~25 live
 * calls ≈ 30 s of rate-limited Discogs time — distinct from, and shorter than,
 * the ~155 s socket timeout below, which adds retry/backoff + transport slack
 * on top of that floor); callers page against this constant. LML returns 413
 * on overflow. Hard contract, not a tunable.
 */
export const ARTIST_RESOLVE_BATCH_CAP = 25;

/**
 * Per-name slice of the batch-size-scaled default timeout. LML processes the
 * API leg serially at the shared 50/min Discogs budget (~1.2 s/name) plus
 * retries/backoff, so the socket budget must grow with batch size or a
 * successful full-escalation batch reads as a transport timeout.
 */
const ARTIST_RESOLVE_PER_NAME_TIMEOUT_MS = 5000;

/**
 * Fixed slack on top of the per-name budget — connection setup, the PG
 * candidate pre-pass, and response serialization, independent of batch size.
 */
const ARTIST_RESOLVE_TIMEOUT_SLACK_MS = 30_000;

/**
 * Bulk-resolve bare artist names to Discogs artist identities via LML's
 * `POST /api/v1/artists/resolve/bulk` (LML#759). Verify-before-mint: LML reads
 * `entity.identity`, generates discogs-cache corroboration candidates, then
 * runs a single-page live Discogs API artist search, minting only on exactly
 * one exact-form candidate with no equality-leg cache conflict. Returns one
 * verdict per input name in input order (`ArtistResolveResult`).
 *
 * Consumer: the concerts headliner backfill (BS#1614) — touring artists absent
 * from the WXYC library that the pure-SQL strict/alias resolver can't reach.
 *
 * Wiring decisions (mirroring `bulkLookupMetadata`):
 *
 * - **One limiter token per batch, not per name.** LML paces its own serial
 *   Discogs fan-out internally; the BS-side limiter mirrors that same shared
 *   ceiling, so token-per-batch is the correct accounting. The default
 *   `limiter` is the process-wide runtime pool (`LML_CLIENT_*`); a full
 *   25-name batch can hold one of its 5 permits for the entire ~155 s socket,
 *   so any runtime/interactive caller MUST pass a dedicated `options.limiter`
 *   (the documented offline consumer does). Defaulting to the runtime pool is
 *   the sibling convention, not an invitation to run big batches on it.
 * - **Timeout scales with batch size.** `names.length ×
 *   ARTIST_RESOLVE_PER_NAME_TIMEOUT_MS (5000) + ARTIST_RESOLVE_TIMEOUT_SLACK_MS
 *   (30_000)` — ~35 s for a 1-name page, ~155 s at the 25 cap. A fixed 30 s
 *   default (this endpoint's `/lookup` siblings) would misclassify a successful
 *   full-escalation batch as a transport timeout. Override via
 *   `options.timeoutMs`. Offline-only caller; a long socket is cheap.
 * - **Span op mirrors `bulkLookupMetadata`** (`http.client`); `lml.bulk.size` is
 *   the batch attribute. No `cache_stats` projection — this endpoint doesn't
 *   return the `/lookup` cache-counter block.
 * - **No `X-Caller-Budget-Ms`.** That header is a `/lookup`-family construct
 *   (it lets LML short-circuit its empty-results cascade); this endpoint does
 *   not honor it, so — unlike the sibling — no `budgetMs` option is offered.
 *
 * Client-side validation rejects empty + oversize batches before the wire call
 * — a 400/413 round-trip costs a TCP RTT for no information gain. The response
 * is then validated to be an index-aligned 1:1 array before return; a length or
 * shape violation throws `LmlClientError(…, 502)` rather than handing a
 * mis-aligned batch to a consumer that zips verdicts to names positionally.
 *
 * Errors (all `LmlClientError`):
 *   - Empty / >25 names: thrown client-side (`400`) before the wire call.
 *   - Timeout: `504` (AbortController fired; rethrown from `lmlFetch`).
 *   - 5xx: `502`. Other non-2xx (incl. a wire `413` if LML's cap ever drops
 *     below 25): the upstream status is passed through.
 *   - Network failure, or a malformed / mis-aligned response body: `502`.
 * Note `escalation_unavailable` is NOT an error — it arrives as a 200-body
 * verdict and is RETRYABLE; consumers must not stamp a no-match TTL on it.
 *
 * @param names - Bare artist names (1..=25), sent verbatim.
 * @param options.timeoutMs - Override the batch-size-scaled default socket timeout (ms).
 * @param options.limiter - Override the default runtime limiter (see the token bullet above).
 * @param options.caller - Caller-class label projected onto the span as `lml.caller`.
 * @param options.dryRun - Run every tier but skip the `entity.identity` write-back.
 */
export async function resolveArtistNamesBulk(
  names: string[],
  options?: { timeoutMs?: number; limiter?: LmlLimiter; caller?: string; dryRun?: boolean }
): Promise<ArtistResolveBulkResponse> {
  if (names.length === 0) {
    throw new LmlClientError('resolveArtistNamesBulk requires at least 1 name.', 400);
  }
  if (names.length > ARTIST_RESOLVE_BATCH_CAP) {
    throw new LmlClientError(
      `resolveArtistNamesBulk exceeded the cap of ${ARTIST_RESOLVE_BATCH_CAP} names (received ${names.length}).`,
      400
    );
  }

  const timeoutMs =
    options?.timeoutMs ?? names.length * ARTIST_RESOLVE_PER_NAME_TIMEOUT_MS + ARTIST_RESOLVE_TIMEOUT_SLACK_MS;

  const body: ArtistResolveBulkRequest = { names };
  if (options?.dryRun) body.dry_run = true;

  const activeLimiter = options?.limiter ?? defaultLimiter;
  return activeLimiter.run(async () => {
    return await Sentry.startSpan({ name: 'lml.artists.resolve.bulk', op: 'http.client' }, async (span) => {
      try {
        span.setAttributes({
          'lml.queue_depth': activeLimiter.state().queueDepth,
          'lml.bulk.size': names.length,
          'lml.caller': options?.caller ?? 'unknown',
        });
      } catch (err) {
        console.warn('lml.client: failed to project queue_depth + bulk.size + caller onto resolve span', err);
      }

      const response = await lmlFetch(
        '/api/v1/artists/resolve/bulk',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs
      );

      let parsed: ArtistResolveBulkResponse;
      try {
        parsed = (await response.json()) as ArtistResolveBulkResponse;
      } catch (err) {
        // A 200 with an unparseable body (truncated stream, or an HTML error
        // page a proxy slipped in front of LML) would otherwise throw a bare
        // SyntaxError that escapes the `LmlClientError` contract this function's
        // JSDoc promises. Wrap it so consumers see one error type.
        throw new LmlClientError(
          `resolveArtistNamesBulk: LML returned an unparseable body: ${(err as Error).message}`,
          502
        );
      }

      // The whole contract is positional: `results[i]` is the verdict for
      // `names[i]` (`ArtistResolveResult` carries no `index` field, unlike
      // `BulkLookupResultItem`). A short, long, reordered, or missing array
      // would let a consumer silently mis-attribute a `discogs_artist_id` to
      // the wrong name and write it. Fail loud at the chokepoint instead.
      if (!Array.isArray(parsed.results) || parsed.results.length !== names.length) {
        const got = Array.isArray(parsed.results) ? `${parsed.results.length} result(s)` : 'a non-array results field';
        throw new LmlClientError(
          `resolveArtistNamesBulk: LML returned ${got} for ${names.length} name(s); expected an index-aligned 1:1 array`,
          502
        );
      }

      return parsed;
    });
  });
}

/**
 * Wire shape for `POST /api/v1/artists/genres/bulk` (LML#781, BS#1624).
 *
 * Reconciled against LML#781's shipped OpenAPI shape (merged as LML#847) and
 * the wxyc-shared `ArtistGenres*` contract (wxyc-shared#235):
 *   - Request: a batch of `{ artist_name, discogs_artist_id? }` under `artists`.
 *   - Response: per-artist `{ genres: string[], styles: string[], source }`,
 *     index-aligned with the request. `ARTIST_GENRES_BATCH_CAP` (25) mirrors
 *     LML's router cap.
 *
 * Defined locally rather than imported from `@wxyc/shared/dtos` because the
 * `ArtistGenres*` schemas — though merged into wxyc-shared/api.yaml (#235) —
 * are not yet in a published `@wxyc/shared` release. Swap these interfaces for
 * the generated `@wxyc/shared/dtos` types once that package publishes the
 * schemas; same deferred-adoption path as `ArtistResolveBulkResponse`.
 */

/** One artist to resolve genres for. `discogs_artist_id` strengthens LML's match when known. */
export interface ArtistGenresRequestItem {
  artist_name: string;
  discogs_artist_id?: number;
}

/**
 * Provenance of one artist's genre/style verdict — the retry-vs-negative-cache
 * discriminator (mirrors `ArtistGenresSource` in wxyc-shared/api.yaml #235):
 *   - `cache`       — served from the discogs-cache genre/style rows.
 *   - `discogs_api` — cache miss; the Discogs API fallback produced genres.
 *   - `not_found`   — Discogs answered; the artist has no genre data. Safe to
 *                     negative-cache (persist an empty row).
 *   - `unavailable` — LML could not consult Discogs (no token, saturation
 *                     breaker open, or a transient fetch failure). RETRY — the
 *                     consumer must NOT negative-cache a couldn't-ask.
 */
export type ArtistGenresSource = 'cache' | 'discogs_api' | 'not_found' | 'unavailable';

/**
 * Genre/style verdict for one input artist, index-aligned with the request's
 * `artists` array. Both arrays are always present (possibly empty) — LML may
 * know the Discogs genre taxonomy for an artist but not the finer-grained
 * styles, or neither. `source` disambiguates an empty verdict: a confirmed
 * "no genres" (persist) versus a transient "couldn't ask" (retry).
 */
export interface ArtistGenresResultItem {
  genres: string[];
  styles: string[];
  source: ArtistGenresSource;
  /**
   * Echoed back from the request by LML (LML#781) for index verification. When
   * present on both sides, the alignment guard asserts it matches the request
   * item at the same index — turning the positional contract from a length
   * check into an identity check. Optional: a name-only request item has no id
   * for LML to echo.
   */
  discogs_artist_id?: number;
  /**
   * The Discogs artist `profile` text, raw (BS#1734 / LML#889). Null for
   * name-only inputs, uncached ids, blank profiles, and not-found tombstones;
   * independent of `source` — a `cache`/`not_found` verdict may still carry a
   * real bio.
   */
  bio?: string | null;
}

export interface ArtistGenresBulkRequest {
  artists: ArtistGenresRequestItem[];
}

export interface ArtistGenresBulkResponse {
  /** One verdict per input artist, in input order. */
  results: ArtistGenresResultItem[];
}

/**
 * LML's per-request cap on `fetchArtistGenresBulk` (LML#781), matching the
 * endpoint's router cap (`_GENRES_INPUT_CAP`). Callers page against this constant.
 */
export const ARTIST_GENRES_BATCH_CAP = 25;

/** Per-artist slice of the batch-size-scaled default socket timeout (ms). */
const ARTIST_GENRES_PER_ITEM_TIMEOUT_MS = 2000;

/** Fixed slack on top of the per-item budget — connection setup + serialization. */
const ARTIST_GENRES_TIMEOUT_SLACK_MS = 20_000;

/**
 * Bulk-resolve artist genres/styles via LML's `POST /api/v1/artists/genres/bulk`
 * (LML#781). Discogs `genres`/`styles` taxonomy for each input artist,
 * aggregated (majority-take) across the artist's releases in the LML
 * discogs-cache. Returns one verdict per input artist in input order.
 *
 * Consumer: the concerts genre enrichment (BS#1624) — persists the result on
 * `artist_metadata` keyed by Discogs artist id, projected onto `Concert.genres`.
 * Runs nightly server-to-server with the LML API key; never in a listener hot
 * path.
 *
 * Wiring mirrors `resolveArtistNamesBulk` (its sibling offline-batch endpoint):
 * one limiter token per BATCH (LML paces its own fan-out internally); a
 * batch-size-scaled socket timeout; a `http.client` span with `lml.bulk.size`.
 * The default `limiter` is the process-wide runtime pool — a big batch can hold
 * a permit for the whole socket, so any offline caller MUST pass a dedicated
 * `options.limiter` (the documented consumer does).
 *
 * Client-side validation rejects empty + oversize batches before the wire call;
 * the response is validated to be an index-aligned 1:1 array before return — by
 * length AND, wherever the request supplied a Discogs id, by LML's echoed
 * `discogs_artist_id` at each index — so a consumer that zips verdicts to
 * artists positionally can never mis-attribute a genre set. All failures throw
 * `LmlClientError`.
 *
 * @param artists - Artists to resolve (1..=`ARTIST_GENRES_BATCH_CAP`).
 * @param options.timeoutMs - Override the batch-size-scaled default socket timeout (ms).
 * @param options.limiter - Override the default runtime limiter (see the token note above).
 * @param options.caller - Caller-class label projected onto the span as `lml.caller`.
 */
export async function fetchArtistGenresBulk(
  artists: ArtistGenresRequestItem[],
  options?: { timeoutMs?: number; limiter?: LmlLimiter; caller?: string }
): Promise<ArtistGenresBulkResponse> {
  if (artists.length === 0) {
    throw new LmlClientError('fetchArtistGenresBulk requires at least 1 artist.', 400);
  }
  if (artists.length > ARTIST_GENRES_BATCH_CAP) {
    throw new LmlClientError(
      `fetchArtistGenresBulk exceeded the cap of ${ARTIST_GENRES_BATCH_CAP} artists (received ${artists.length}).`,
      400
    );
  }

  const timeoutMs =
    options?.timeoutMs ?? artists.length * ARTIST_GENRES_PER_ITEM_TIMEOUT_MS + ARTIST_GENRES_TIMEOUT_SLACK_MS;

  const body: ArtistGenresBulkRequest = { artists };

  const activeLimiter = options?.limiter ?? defaultLimiter;
  return activeLimiter.run(async () => {
    return await Sentry.startSpan({ name: 'lml.artists.genres.bulk', op: 'http.client' }, async (span) => {
      try {
        span.setAttributes({
          'lml.queue_depth': activeLimiter.state().queueDepth,
          'lml.bulk.size': artists.length,
          'lml.caller': options?.caller ?? 'unknown',
        });
      } catch (err) {
        console.warn('lml.client: failed to project queue_depth + bulk.size + caller onto genres span', err);
      }

      const response = await lmlFetch(
        '/api/v1/artists/genres/bulk',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs
      );

      let parsed: ArtistGenresBulkResponse;
      try {
        parsed = (await response.json()) as ArtistGenresBulkResponse;
      } catch (err) {
        throw new LmlClientError(
          `fetchArtistGenresBulk: LML returned an unparseable body: ${(err as Error).message}`,
          502
        );
      }

      // Positional contract: `results[i]` is the verdict for `artists[i]`. A
      // short / long / missing array — or a null body — would let the consumer
      // write one artist's genres onto another's Discogs id. Fail loud at the
      // chokepoint (mirrors `resolveArtistNamesBulk`).
      if (parsed == null || !Array.isArray(parsed.results) || parsed.results.length !== artists.length) {
        const got =
          parsed != null && Array.isArray(parsed.results)
            ? `${parsed.results.length} result(s)`
            : 'a non-array results field';
        throw new LmlClientError(
          `fetchArtistGenresBulk: LML returned ${got} for ${artists.length} artist(s); expected an index-aligned 1:1 array`,
          502
        );
      }

      // Defense-in-depth beyond length: when both the request item and the
      // echoed verdict carry a Discogs id, they MUST match at this index. LML
      // echoes `discogs_artist_id` for exactly this check (LML#781); a mismatch
      // means the array was reordered under us, which the length check alone
      // can't catch. The consumer (BS#1624) zips genres to Discogs ids
      // positionally, so a silent reorder would mis-attribute a genre set.
      for (let i = 0; i < artists.length; i++) {
        const sent = artists[i].discogs_artist_id;
        const echoed = parsed.results[i].discogs_artist_id;
        if (sent != null && echoed != null && sent !== echoed) {
          throw new LmlClientError(
            `fetchArtistGenresBulk: LML echoed discogs_artist_id ${echoed} at index ${i} but the request sent ${sent}; the results array is misordered`,
            502
          );
        }
      }

      return parsed;
    });
  });
}

/**
 * Check whether the LML service is configured.
 */
export function isLmlConfigured(): boolean {
  return !!process.env.LIBRARY_METADATA_URL;
}
