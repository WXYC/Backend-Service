/**
 * Per-row canonical-entity resolver for the B-1.2 library backfill.
 *
 * Maps an LML lookup response to one of three outcomes derived from B-0's
 * calibrated heuristic (issue #492 comment). LML does not expose per-result
 * confidence today (tracked at WXYC/library-metadata-lookup#158); when it
 * does, this resolver collapses to a numeric threshold and the search_type
 * branch goes away.
 *
 * Outcomes:
 *   - auto_accept — search_type=direct AND first result has artwork.release_id.
 *     The canonical_entity_id is namespaced as `discogs:<release_id>` so a
 *     future MusicBrainz-only result won't collide on the same scheme.
 *   - review — any non-empty result that isn't a direct hit. The orchestrator
 *     still stamps resolved_at so B-3.1's review queue can find it; canonical
 *     id stays NULL.
 *   - no_match — empty result set, OR a direct match whose top result has no
 *     pinable Discogs release_id. The orchestrator does not stamp anything
 *     so the next sweep retries.
 */

import type { LookupResponse } from '@wxyc/shared/dtos';

export type Resolution =
  | { status: 'auto_accept'; canonical_entity_id: string; confidence: number }
  | { status: 'review' }
  | { status: 'no_match' };

/**
 * Confidence assigned to direct-hit auto-accepts. LML doesn't return a
 * per-result number today, so we synth a single value for retroactive
 * filtering. The actual scalar is somewhat arbitrary — what matters is that
 * any future numeric-threshold path keeps the row above its cutoff.
 */
const AUTO_ACCEPT_CONFIDENCE = 0.95;

/**
 * Build a namespaced canonical entity id. The schema column is opaque text;
 * the prefix lets B-2 disambiguate sources cleanly when LML adds more.
 */
const toCanonicalEntityId = (releaseId: number): string => `discogs:${releaseId}`;

export const resolveCanonicalEntity = (response: LookupResponse): Resolution => {
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

export { AUTO_ACCEPT_CONFIDENCE };
