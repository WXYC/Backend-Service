/**
 * Pure classification of an LML re-verify response into a write decision (BS#2000).
 *
 * The whole job turns on getting this three-way, not two-way. A wrong V/A
 * Apple deep-link and a correct one are indistinguishable at rest — the row
 * doesn't record which matcher pass won — so the only way to tell them apart
 * is to re-ask LML now that the #1139 guard is live. But "LML returned no
 * Apple URL" is a much weaker signal than it looks, and treating it as a
 * definitive no-match is how this job would destroy the data it exists to
 * protect:
 *
 *   - LML#904 measured that at the default `LML_APPLE_MUSIC_RATE_PER_MIN=60`
 *     roughly 56% of `find_track_url` probes time out on LML's OWN
 *     self-throttle and return null, with zero 429s. The wait is acquire-time,
 *     not Apple latency.
 *   - LML#706's streaming post-process is eventually consistent, so a first
 *     lookup can legitimately return null and a later one the real URL. That
 *     is the entire premise of the BS#1631 sibling job.
 *   - A shed, an open breaker, or a BS#1293 `skipped_discogs_unavailable`
 *     window all produce a well-formed response carrying no URL.
 *
 * Collapsing any of those into "no match" would NULL a correct link — and
 * flowsheet nulls are terminal, since the enrichment worker never revisits
 * `enriched_match` rows. Same doctrine as BS#1915 (`apps/enrichment-worker/
 * enrich.ts`): "null is load-bearing ... instead of silently freezing a
 * transient null".
 *
 * So `indeterminate` is a first-class outcome that writes NOTHING and stays
 * retryable, and `none` is only reachable after repeated confirmation
 * (`orchestrate.ts` requires three consecutive null passes).
 */

import { shedReasonOf, type GatedLookupResponse } from '@wxyc/lml-client';

/** What the caller should do with every row carrying this triple. */
export type Verdict =
  /** Write this URL — LML re-adjudicated the triple under the #1139 guard. */
  | { kind: 'url'; url: string }
  /** No Apple match. Safe to NULL — but only after repeated confirmation. */
  | { kind: 'none' }
  /** Write nothing; retryable. The response carries no usable evidence. */
  | { kind: 'indeterminate'; reason: IndeterminateReason };

export type IndeterminateReason =
  'shed_limiter_saturated' | 'shed_breaker_open' | 'skipped_discogs_unavailable' | 'empty_results';

/**
 * Read the Apple Music URL off the top-1 result's artwork block.
 *
 * Top-1 only, mirroring what the enrichment worker persisted from the original
 * lookup: a URL on a lower-ranked (different-release) result is not evidence
 * about THIS row. An empty string coerces to null so a degenerate response can
 * never write a blank into the column.
 */
export const extractAppleMusicUrl = (response: GatedLookupResponse): string | null => {
  const url = response.results?.[0]?.artwork?.apple_music_url;
  return url ? url : null;
};

/**
 * Classify one LML response.
 *
 * `results.length === 0` is INDETERMINATE, not `none`: "the library row wasn't
 * found on this attempt" is not evidence that the stored URL is wrong. The
 * `none` verdict requires LML to have found the row and reported no Apple
 * match for it.
 *
 * The shed arm cannot currently fire through this job's limiter — a job-owned
 * `createLmlLimiter({ maxConcurrent, ratePerMinute })` passes neither `breaker`
 * nor `queueWaitMs`, and the client only throws `LimiterShedError` when one is
 * configured ("job limiters keep the unbounded shape"). It is kept as a
 * forward-compat pin so reconfiguring the limiter later cannot silently turn a
 * shed into a data-destroying `none`; it is NOT counted as an active
 * mitigation anywhere.
 */
export const classifyResponse = (response: GatedLookupResponse): Verdict => {
  const shed = shedReasonOf(response);
  if (shed) return { kind: 'indeterminate', reason: shed };
  if (response.outcome === 'skipped_discogs_unavailable') {
    return { kind: 'indeterminate', reason: 'skipped_discogs_unavailable' };
  }
  if (!response.results || response.results.length === 0) {
    return { kind: 'indeterminate', reason: 'empty_results' };
  }
  const url = extractAppleMusicUrl(response);
  return url ? { kind: 'url', url } : { kind: 'none' };
};
