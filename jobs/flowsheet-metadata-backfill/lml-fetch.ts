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
 *     LML call; on miss the call result is stored; on hit, streaming
 *     URL fields are blanked at the cache boundary so enrich.ts's
 *     existing `??` fallback drops through to per-row search-URL
 *     synthesis (BS#1185 — LML's streaming URLs are track-aware). See
 *     `lookup-cache.ts` for the dedup design.
 *
 * The third parameter is named `track` (not `song`) to match the orchestrator's
 * `EnrichRow.track_title` field. It's plumbed through to LML's `body.song` by
 * the shared client — `@wxyc/lml-client` exhaustively tests the wire shape
 * (#888 regression), so this shim doesn't repeat that assertion.
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';
import { defaultLookupCache, type LookupCache } from './lookup-cache.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Number(raw) (not parseInt) so partial-parse strings like "8000banana"
  // surface as NaN and get rejected instead of silently coercing.
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 35_000);

let activeCache: LookupCache = defaultLookupCache;

/**
 * Test-only seam. Production code wires `defaultLookupCache` at module
 * load; tests construct a fresh `LookupCache` per test so state doesn't
 * leak between cases.
 */
export const __setLookupCacheForTesting = (cache: LookupCache): void => {
  activeCache = cache;
};

/**
 * Read the module-level cache. Exported so the orchestrator can include
 * `cache_hits` / `cache_misses` / `cache_size` in its `batch_done` log line.
 */
export const getLookupCache = (): LookupCache => activeCache;

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<LookupResponse> => {
  const cached = activeCache.get(artist, album);
  if (cached !== undefined) return cached;

  const response = await sharedLookupMetadata(artist, album, track, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'flowsheet-metadata-backfill',
  });

  activeCache.set(artist, album, response);
  return response;
};
