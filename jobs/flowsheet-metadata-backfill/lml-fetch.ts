/**
 * Backfill-side LML lookup helper for the historical metadata drain
 * (#638 / #641).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint introduced in BS#887) and injects:
 *   - the backfill's own `defaultLmlLimiter` so this surface gets its stricter
 *     BACKFILL_LML_* rate ceiling instead of the runtime path's
 *     LML_CLIENT_* defaults (BS#995 / BS#994),
 *   - a per-call abort budget (`BACKFILL_LML_PER_CALL_TIMEOUT_MS`,
 *     default 35_000 ms). Sized to clear LML#370's 25.25 s per-item
 *     cascade-exhaustion cap (deployed to LML prod 2026-05-25) plus
 *     ~10 s of headroom for LML queue contention with the live backend +
 *     ROM. The prior 8000 ms default (BS#994, retro 2026-05-23) was set
 *     against the pre-LML#370 topology and aborted before LML could
 *     return its `{timeout:true, results:[]}` body for cascade-bait
 *     rows — those rows stayed `metadata_attempt_at IS NULL` and the
 *     cron re-failed them every pass. BS#1064 / BS#1180 empirical
 *     re-validation: at 8 s, ~86% per-row `lml_error`; at 35 s, ~23%.
 *     The 35 s budget lets the timeout body reach `applyEnrichment`'s
 *     empty-results branch so the row drains as `enriched_no_match`
 *     instead of looping. Steady-state `lml_error` floor (LML queue
 *     contention rows the per-row defaults can't fix) is drained by
 *     BS#1199's planned retry cap. Pattern mirrors BS#992's per-caller
 *     timeout for the rotation picker, and
 *   - a run-scoped (artist, album) dedup cache (`defaultLookupCache`).
 *     Prod measurement on 2026-06-03: 628,561 pending unlinked flowsheet
 *     rows resolve to 362,258 distinct (artist, album) pairs — a 1.74×
 *     multiplier. The cache cuts the LML call budget by ~42% without
 *     pacing changes or schema changes. Cache is consulted before the
 *     LML call; on miss the call result is stored EXCEPT when LML
 *     signaled a cascade timeout (`response.timeout === true`) or
 *     (BS#1995 Arm 3, tightened after review) an UNANSWERED breaker-open
 *     shed — `degraded_reason: 'upstream_unavailable'` or a `shedReasonOf`
 *     match, AND no usable artwork (`extractArtwork(response) === null`;
 *     see `isUnansweredShed` below and its `enrich.ts` twin) — those
 *     responses are NOT cached, so sibling rows of the same
 *     `(artist, album)` later in the same run still each call LML (each
 *     gets its own chance to land while LML recovers), and any NEW
 *     flowsheet rows of that pair in future cron runs start with a fresh
 *     cache and a fresh LML call. A breaker-open response that DOES carry
 *     a match (LML's tail legs can complete before the breaker trips) is
 *     cached normally, same as any other match. The originating row of a
 *     cascade timeout is still drained as `enriched_no_match` by
 *     `applyEnrichment` (intentional per the 35 s timeout budget above —
 *     the alternative is the row loops every cron pass), so in that case
 *     this guard only saves peers in this run and successor rows in
 *     future runs, not the row that received the timeout body itself. The
 *     originating row of a genuinely unanswered breaker-open shed is NOT
 *     drained at all — `applyEnrichment` refuses to write any verdict for
 *     it (see `enrich.ts`'s `upstream_unavailable_skipped` outcome) — so
 *     that row is retried on a later sweep too. On hit, per-track URL fields are stripped at the
 *     cache boundary (BS#1185 search URLs + BS#1192 apple_music_url
 *     are track-aware on LML's side); enrich.ts's existing `??`
 *     fallback drops through to per-row synthesis for the search URLs.
 *     For apple_music_url (BS#1192 — `null` is load-bearing "no
 *     verified iTunes match"), enrich.ts uses a conditional spread on
 *     the `'apple_music_url' in artwork` witness: present means LML
 *     decided (string or null) so we record it; absent means the
 *     cache stripped it, so we OMIT the column from the album_metadata
 *     UPSERT and inline flowsheet UPDATE so a prior verified URL on
 *     the album is preserved instead of being overwritten with null.
 *     See `lookup-cache.ts` for the dedup design.
 *
 * The third parameter is named `track` (not `song`) to match the orchestrator's
 * `EnrichRow.track_title` field. It's plumbed through to LML's `body.song` by
 * the shared client — `@wxyc/lml-client` exhaustively tests the wire shape
 * (#888 regression), so this shim doesn't repeat that assertion.
 */

import {
  lookupMetadata as sharedLookupMetadata,
  shedReasonOf,
  type GatedLookupResponse,
  type LookupResponse,
} from '@wxyc/lml-client';

import { parseEnvInt } from './env-int.js';
import { extractArtwork } from './enrich.js';
import { defaultLmlLimiter } from './lml-limiter.js';
import { defaultLookupCache, type LookupCache } from './lookup-cache.js';

const envInt = (name: string, fallback: number): number =>
  parseEnvInt(
    name,
    fallback,
    'positive',
    (raw) => `lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`
  );

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 35_000);

let activeCache: LookupCache = defaultLookupCache;

/**
 * Test-only seam. Production must never reach this — flipping the cache
 * mid-run would silently zero accumulated hit state. Guarded against
 * accidental import by checking `NODE_ENV === 'test'` at call time.
 */
export const __setLookupCacheForTesting = (cache: LookupCache): void => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setLookupCacheForTesting must not be called outside NODE_ENV=test');
  }
  activeCache = cache;
};

/**
 * Read the module-level cache. Exported so the orchestrator can include
 * `cache_hits` / `cache_misses` / `cache_size` in its `batch_done` log line.
 */
export const getLookupCache = (): LookupCache => activeCache;

/**
 * LML returns a 200 OK with `{timeout: true, results: []}` when its
 * server-side hard cap fires and the search pipeline is abandoned
 * mid-execution (LML#370). The `timeout` boolean is on the typed
 * `LookupResponse` (see `@wxyc/shared` DTOs); we check it explicitly
 * because at the `results` level the shape is identical to a real
 * no-match. These responses are transient signals about LML load, not
 * answers about (artist, album), so they must not be cached — caching
 * one would lock in `enriched_no_match` for every subsequent row of
 * the same key for the rest of the run AND stamp the rows so future
 * cron passes also skip them.
 */
const hasUpstreamTimeout = (response: LookupResponse): boolean => response.timeout === true;

/**
 * BS#1995 Arm 3 (tightened after review — B2 + S6): a breaker-open response
 * is only a "transient signal about LML load, not an answer" — the same
 * shape as `hasUpstreamTimeout` above, and for the same reason must not be
 * cached — when it carries no usable match. LML's degraded-response builder
 * still returns whatever the tail legs already produced before the breaker
 * tripped (`fetch_artwork` runs BEFORE `enrich_metadata`/identity
 * resolution, both of which can raise the breaker-open error), so a
 * `degraded_reason: 'upstream_unavailable'` response CAN carry a complete,
 * cacheable match. Caching a genuinely unanswered one would lock in an
 * unanswered-not-no-match verdict for every subsequent row of the same
 * (artist, album) for the rest of the run; `enrich.ts:applyEnrichment`
 * mirrors this exact `artwork === null` gate so the two decisions never
 * diverge (a response this guard excludes from the cache is also a
 * response `applyEnrichment` refuses to write a verdict for, and vice
 * versa).
 *
 * S6: also checks `shedReasonOf` — the shed shape `@wxyc/lml-client`'s
 * limiter returns when a call is shed (queue saturated or breaker open,
 * BS#1748) carries no `degraded_reason` at all, only an `outcome`
 * discriminator. This job's limiter is unbounded today so no shed can
 * reach here, but the moment a bounded shape is applied to this caller
 * every shed would otherwise silently re-poison the cache exactly like the
 * incident this ticket closes.
 */
const isUnansweredShed = (response: LookupResponse): boolean => {
  // Safe cast, not a type-hole — see enrich.ts's identical cast for why:
  // `lookupMetadata` already resolves `GatedLookupResponse` under the hood;
  // this module's local `LookupResponse` typing just doesn't carry it.
  const isShed =
    response.degraded_reason === 'upstream_unavailable' || shedReasonOf(response as GatedLookupResponse) !== undefined;
  return isShed && extractArtwork(response) === null;
};

/**
 * Result of a lookup, with provenance: did we serve from cache?
 * The orchestrator uses `cacheHit` to skip the per-row throttle on
 * hits (the throttle exists to space LML calls; a cache hit makes no
 * LML call so the sleep is wall-clock waste). Pre-cache, lookupMetadata
 * returned a bare LookupResponse; bumping the shape to an object lets
 * us thread the hit signal back to the orchestrator without recomputing
 * cache stats deltas around every row.
 */
export type LookupResult = { response: LookupResponse; cacheHit: boolean };

export const lookupMetadata = async (
  artist: string,
  album?: string,
  track?: string,
  // BS#1294 (1c): pre-read `library.discogs_unavailable` from the
  // orchestrator's batch loader; forwarded to the BS#1293 gate in
  // `@wxyc/lml-client`, which short-circuits the LML call.
  discogsUnavailable?: boolean
): Promise<LookupResult> => {
  const cached = activeCache.get(artist, album);
  if (cached !== undefined) return { response: cached, cacheHit: true };

  const response = await sharedLookupMetadata(artist, album, track, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'flowsheet-metadata-backfill',
    discogsUnavailable,
  });

  if (!hasUpstreamTimeout(response) && !isUnansweredShed(response)) {
    activeCache.set(artist, album, response);
  }
  return { response, cacheHit: false };
};
