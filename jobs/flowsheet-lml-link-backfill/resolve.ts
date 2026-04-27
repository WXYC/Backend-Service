/**
 * Per-row LML signal resolver for the B-2.2 flowsheet backfill.
 *
 * Maps an LML lookup response to one of three outcomes derived from B-0's
 * calibrated heuristic (issue #492 comment). LML doesn't expose per-result
 * confidence today (tracked at WXYC/library-metadata-lookup#158); when it
 * does, this resolver collapses to a numeric threshold and the search_type
 * branch goes away.
 *
 * Outcomes:
 *   - auto_accept — search_type=direct AND first result has artwork.release_id.
 *     The canonical_entity_id is namespaced `discogs:<release_id>` to match
 *     what the B-1.2 library backfill stamped on `library.canonical_entity_id`.
 *   - review     — any non-empty result that isn't a direct hit. Surfaces to
 *     B-3.1 review rather than guessing.
 *   - no_match   — empty result set, OR a direct match whose top result has
 *     no pinable Discogs release_id. The orchestrator writes nothing so the
 *     row stays in the retry pool for the next sweep.
 */

import type { LmlLookupResponse } from './lml-types.js';

export type LmlSignal =
  | { status: 'auto_accept'; canonical_entity_id: string; confidence: number }
  | { status: 'review' }
  | { status: 'no_match' };

/**
 * Confidence assigned to direct-hit auto-accepts. LML doesn't return a
 * per-result number today, so we synth a single value for retroactive
 * filtering. Mirrors `AUTO_ACCEPT_CONFIDENCE` in B-1.2's resolver.
 */
export const AUTO_ACCEPT_CONFIDENCE = 0.95;

const toCanonicalEntityId = (releaseId: number): string => `discogs:${releaseId}`;

export const resolveLmlSignal = (response: LmlLookupResponse): LmlSignal => {
  const top = response.results?.[0];
  if (!top) {
    return { status: 'no_match' };
  }

  const releaseId = top.artwork?.release_id;

  if (response.search_type === 'direct') {
    if (typeof releaseId !== 'number') {
      return { status: 'no_match' };
    }
    return {
      status: 'auto_accept',
      canonical_entity_id: toCanonicalEntityId(releaseId),
      confidence: AUTO_ACCEPT_CONFIDENCE,
    };
  }

  return { status: 'review' };
};
