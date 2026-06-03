/**
 * Empty-outcome classification for enrichment-worker Sentry observability
 * (BS#969 / Epic G G7).
 *
 * The legacy `Sentry.captureException` path in `apps/backend/services/metadata`
 * only fires when `lookupMetadata` throws — it catches LML timeouts but misses
 * the dominant failure mode: LML responds inside its budget with a degraded
 * result (artwork object present but `artwork_url` null, the LML#408 class).
 * The 2026-05-19 data pull on BS#692 quantified the gap at ~50–500× undercount
 * against the actual prod degradation rate.
 *
 * This module exports a pure predicate + cause classifier so the worker can
 * fire a structured `Sentry.captureMessage('enrichment-empty-outcome', ...)`
 * on every empty outcome — caught throws AND finalized rows that landed
 * user-visibly blank — with a stable fingerprint that survives release tag
 * changes.
 *
 * "Empty outcome" is defined against the LML response, not the post-write
 * row state: the worker's write path always synthesizes fallback search URLs
 * (spotify/youtube/bandcamp/soundcloud), so the BS#969-original "all five row
 * columns IS NULL" predicate would never trigger after consumer writes. The
 * user-facing definition that matters is "no Discogs-derived artwork URL" —
 * that's what shows up as a blank cover tile on iOS / dj-site.
 */

import type { LookupResponse } from '@wxyc/lml-client';

import { extractArtwork } from './enrich.js';

export type EmptyOutcomeCause = 'lml_degraded' | 'lml_no_match' | 'lml_timeout' | 'unknown';

/**
 * True if the LML response will produce a user-visibly blank artwork tile:
 * either no Discogs match at all (artwork === null) or a match whose
 * `artwork_url` is missing (the LML#408 `_resolve_fallback_artwork` class).
 *
 * Does NOT cover the LML-threw path; the caller in handler.ts fires the
 * `lml_timeout` cause separately from its catch arm.
 */
export const isEmptyOutcome = (response: LookupResponse): boolean => {
  const artwork = extractArtwork(response);
  if (!artwork) return true;
  return !artwork.artwork_url;
};

/**
 * Classify an empty-outcome response into the cause tag that distinguishes
 * LML-side failure modes on the aggregated Sentry issue. Caller should only
 * invoke this when `isEmptyOutcome(response)` is true.
 *
 * The `lml_timeout` cause is unreachable from this function (the LML throw
 * path lives in handler.ts's catch arm); it exists in `EmptyOutcomeCause`
 * because the catch arm uses it as a tag value on its own captureMessage.
 */
export const classifyEmptyCause = (response: LookupResponse): Exclude<EmptyOutcomeCause, 'lml_timeout'> => {
  const artwork = extractArtwork(response);
  if (!artwork) return 'lml_no_match';
  if (!artwork.artwork_url) return 'lml_degraded';
  return 'unknown';
};

/**
 * Stable Sentry fingerprint so all four `cause` classifications group onto
 * a single long-lived issue that survives release tag changes. Tag-filter
 * within Sentry to split causes when triaging.
 */
export const EMPTY_OUTCOME_FINGERPRINT = ['enrichment-empty-outcome', 'subsystem-metadata'];
