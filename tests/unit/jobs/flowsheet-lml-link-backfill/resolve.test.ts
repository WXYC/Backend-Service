/**
 * Unit tests for the B-2.2 per-row LML signal resolver.
 *
 * Mirrors the B-1.2 resolver's contract: maps an LML lookup response to one
 * of three outcomes derived from the B-0 calibrated heuristic (issue #492):
 *
 *   - auto_accept — search_type=direct AND first result has artwork.release_id.
 *   - review     — any non-empty result that isn't a direct hit (LML found
 *                  *something* by the artist, but not the exact release).
 *   - no_match   — empty result set, OR a direct match whose top result has
 *                  no pinable Discogs release_id. Retried on the next sweep.
 *
 * The auto_accept canonical_entity_id is namespaced `discogs:<release_id>` so
 * it joins the `library.canonical_entity_id` rows populated by the B-1.2
 * library backfill. Future sources (MusicBrainz, etc.) get their own prefix.
 */

import {
  resolveLmlSignal,
  AUTO_ACCEPT_CONFIDENCE,
} from '../../../../jobs/flowsheet-lml-link-backfill/resolve';
import type { LmlLookupResponse } from '../../../../jobs/flowsheet-lml-link-backfill/lml-types';

const directResponse = (releaseId: number): LmlLookupResponse => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id: releaseId } }],
  search_type: 'direct',
});

const fallbackResponse = (releaseId: number): LmlLookupResponse => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id: releaseId } }],
  search_type: 'fallback',
});

const emptyResponse = (): LmlLookupResponse => ({
  results: [],
  search_type: 'none',
});

describe('resolveLmlSignal', () => {
  it('returns auto_accept on a direct hit with a Discogs release_id', () => {
    // search_type=direct is the calibrated auto-accept signal (B-0). Without a
    // pinable release_id we can't form a canonical_entity_id to join against
    // library.canonical_entity_id, so we drop to no_match (see separate case).
    const result = resolveLmlSignal(directResponse(987654));

    expect(result.status).toBe('auto_accept');
    if (result.status !== 'auto_accept') return;
    expect(result.canonical_entity_id).toBe('discogs:987654');
    expect(result.confidence).toBe(AUTO_ACCEPT_CONFIDENCE);
  });

  it('namespaces the canonical_entity_id with the discogs scheme', () => {
    // Library rows populated by the B-1.2 backfill are stored with a
    // `discogs:<release_id>` prefix. If this resolver drifts to a different
    // scheme, the orchestrator's library lookup quietly returns zero matches
    // for every row and the backfill writes nothing.
    const result = resolveLmlSignal(directResponse(111));

    expect(result.status).toBe('auto_accept');
    if (result.status !== 'auto_accept') return;
    expect(result.canonical_entity_id).toMatch(/^discogs:/);
  });

  it('returns review on a fallback hit', () => {
    // B-0 calibration: search_type=fallback is "wrong-album-by-right-artist"
    // — LML returns *something* by the artist when it can't find the release.
    // These go to B-3.1 review, not auto-accept.
    const result = resolveLmlSignal(fallbackResponse(33));

    expect(result.status).toBe('review');
  });

  it('returns review on alternative / compilation / song_as_artist results', () => {
    // Anything non-empty that isn't a direct hit is gray-zone — surface to
    // review rather than guessing.
    expect(resolveLmlSignal({ results: [{ library_item: { id: 1 }, artwork: { release_id: 1 } }], search_type: 'alternative' }).status).toBe('review');
    expect(resolveLmlSignal({ results: [{ library_item: { id: 1 }, artwork: { release_id: 1 } }], search_type: 'compilation' }).status).toBe('review');
    expect(resolveLmlSignal({ results: [{ library_item: { id: 1 }, artwork: { release_id: 1 } }], search_type: 'song_as_artist' }).status).toBe('review');
  });

  it('returns no_match on an empty results set', () => {
    // 0 results = "discard, retry on next sweep" per B-0.
    expect(resolveLmlSignal(emptyResponse()).status).toBe('no_match');
  });

  it('returns no_match on a direct hit without a pinable release_id', () => {
    // A direct match whose top result has no artwork.release_id can't be
    // pinned to a canonical entity. Retry on the next sweep — perhaps LML's
    // cache has filled in by then.
    const response: LmlLookupResponse = {
      results: [{ library_item: { id: 1 } }],
      search_type: 'direct',
    };

    expect(resolveLmlSignal(response).status).toBe('no_match');
  });
});
