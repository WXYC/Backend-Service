/**
 * Unit tests for the per-row canonical-entity resolver (B-1.2).
 *
 * The resolver receives an LML lookup response and returns one of:
 *   - { status: 'auto_accept', canonical_entity_id, confidence } — write all
 *     three columns and stop. Search ran direct (clean typo or exact match)
 *     and produced ≥1 result with a Discogs release_id we can pin.
 *   - { status: 'review' } — fallback hit (right-artist-wrong-album risk).
 *     Stamp resolved_at so B-3.1 can find it; leave canonical_entity_id NULL.
 *   - { status: 'no_match' } — LML returned 0 results. Don't stamp anything;
 *     a future LML improvement may resolve on the next sweep.
 *
 * The heuristic table is from B-0's calibration sample (issue #492 comment).
 * If LML ships per-result confidence (LML#158), this resolver collapses to a
 * numeric threshold and the search_type branch goes away.
 */

import type {
  LmlLookupResponse,
  LmlLookupResultItem,
} from '../../../../jobs/library-canonical-entity-backfill/lml-types';
import { resolveCanonicalEntity } from '../../../../jobs/library-canonical-entity-backfill/resolve';

const itemWithReleaseId = (releaseId: number): LmlLookupResultItem => ({
  library_item: { id: 12345 },
  artwork: { release_id: releaseId },
});

const itemWithoutArtwork: LmlLookupResultItem = {
  library_item: { id: 99 },
};

const responseFor = (overrides: Partial<LmlLookupResponse>): LmlLookupResponse => ({
  results: [],
  search_type: 'none',
  song_not_found: false,
  found_on_compilation: false,
  ...overrides,
});

describe('resolveCanonicalEntity', () => {
  describe('auto-accept branch', () => {
    it('auto-accepts when search_type=direct with ≥1 result that has a Discogs release_id', () => {
      // The clean-typo / exact-match case from B-0's calibration. These were
      // the 10-15% gain bucket in the sample (Loney Dear, Andy Stott, etc.).
      const response = responseFor({
        results: [itemWithReleaseId(987654)],
        search_type: 'direct',
      });

      const result = resolveCanonicalEntity(response);

      expect(result.status).toBe('auto_accept');
      if (result.status === 'auto_accept') {
        expect(result.canonical_entity_id).toBe('discogs:987654');
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('namespaces the canonical_entity_id with the source scheme (discogs:<id>)', () => {
      // The schema column is opaque text. The namespace lets future B-2 joins
      // disambiguate Discogs from MusicBrainz when LML adds MB-only matches.
      const response = responseFor({
        results: [itemWithReleaseId(1)],
        search_type: 'direct',
      });

      const result = resolveCanonicalEntity(response);

      if (result.status !== 'auto_accept') throw new Error('expected auto_accept');
      expect(result.canonical_entity_id).toMatch(/^discogs:/);
    });

    it('takes the first result when LML returns several direct matches', () => {
      // LML orders results by relevance. Picking the top one is the
      // documented "highest-confidence" behavior.
      const response = responseFor({
        results: [itemWithReleaseId(111), itemWithReleaseId(222)],
        search_type: 'direct',
      });

      const result = resolveCanonicalEntity(response);

      if (result.status !== 'auto_accept') throw new Error('expected auto_accept');
      expect(result.canonical_entity_id).toBe('discogs:111');
    });
  });

  describe('review branch', () => {
    it('routes search_type=fallback with results to manual review (not auto_accept)', () => {
      // B-0's calibration: fallbacks are mostly wrong-album-by-right-artist.
      // Stamping resolved_at lets B-3.1 find the row; leaving canonical_entity_id
      // NULL keeps it out of the auto-accepted analytics until a human OKs it.
      const response = responseFor({
        results: [itemWithReleaseId(33)],
        search_type: 'fallback',
      });

      const result = resolveCanonicalEntity(response);

      expect(result.status).toBe('review');
    });

    it('routes search_type=alternative / compilation / song_as_artist to review', () => {
      // Conservative default: only `direct` clears the auto-accept bar. Other
      // strategies are speculative enough that B-0's sample didn't validate
      // them — push them to review.
      for (const search_type of ['alternative', 'compilation', 'song_as_artist'] as const) {
        const response = responseFor({
          results: [itemWithReleaseId(33)],
          search_type,
        });
        expect(resolveCanonicalEntity(response).status).toBe('review');
      }
    });
  });

  describe('no_match branch', () => {
    it('reports no_match when LML returns 0 results regardless of search_type', () => {
      // B-0: empty result sets are "discard, retry on next sweep". The
      // orchestrator must NOT stamp resolved_at on no_match so a future LML
      // improvement can pick the row up.
      for (const search_type of ['direct', 'fallback', 'none'] as const) {
        const response = responseFor({ results: [], search_type });
        expect(resolveCanonicalEntity(response).status).toBe('no_match');
      }
    });

    it('reports no_match when the top result has no artwork (no Discogs release_id to pin)', () => {
      // Without an artwork.release_id, there's no canonical entity to write.
      // Treat as no_match — retry next sweep, where LML may have indexed
      // the release.
      const response = responseFor({
        results: [itemWithoutArtwork],
        search_type: 'direct',
      });

      const result = resolveCanonicalEntity(response);

      expect(result.status).toBe('no_match');
    });
  });
});
