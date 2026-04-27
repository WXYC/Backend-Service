import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
}));

import { mapLookupToCanonicalEntity, updateCanonicalEntity } from '../../../apps/backend/services/library.service';

describe('library.service: canonical entity (B-1.3)', () => {
  describe('mapLookupToCanonicalEntity', () => {
    const releaseResult = (release_id: number) => ({
      library_item: { id: 1 },
      artwork: { release_id, release_url: '', confidence: 0 },
    });

    it('returns null when there are no results', () => {
      expect(
        mapLookupToCanonicalEntity({
          results: [],
          search_type: 'none',
          song_not_found: false,
          found_on_compilation: false,
        })
      ).toBeNull();
    });

    it('returns null when the top result has no Discogs release_id', () => {
      expect(
        mapLookupToCanonicalEntity({
          results: [{ library_item: { id: 1 } }],
          search_type: 'direct',
          song_not_found: false,
          found_on_compilation: false,
        })
      ).toBeNull();
    });

    it('namespaces the Discogs release_id and tags direct matches with high confidence', () => {
      const result = mapLookupToCanonicalEntity({
        results: [releaseResult(123456)],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      expect(result).toEqual({ id: 'discogs:release:123456', confidence: 0.9 });
    });

    it('tags fallback matches with review-zone confidence (per B-0 calibration)', () => {
      const result = mapLookupToCanonicalEntity({
        results: [releaseResult(987)],
        search_type: 'fallback',
        song_not_found: true,
        found_on_compilation: false,
      });

      expect(result).toEqual({ id: 'discogs:release:987', confidence: 0.5 });
    });

    it('tags alternative / compilation / song_as_artist matches with low confidence', () => {
      for (const search_type of ['alternative', 'compilation', 'song_as_artist'] as const) {
        const result = mapLookupToCanonicalEntity({
          results: [releaseResult(42)],
          search_type,
          song_not_found: false,
          found_on_compilation: search_type === 'compilation',
        });
        expect(result).toEqual({ id: 'discogs:release:42', confidence: 0.3 });
      }
    });
  });

  describe('updateCanonicalEntity', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('writes the entity id, confidence, and a resolved-at timestamp', async () => {
      const chain = createMockQueryChain([{ id: 7 }]);
      db.update.mockReturnValue(chain);

      await updateCanonicalEntity(7, 'discogs:release:111', 0.9);

      expect(db.update).toHaveBeenCalled();
      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          canonical_entity_id: 'discogs:release:111',
          canonical_entity_confidence: 0.9,
          canonical_entity_resolved_at: expect.any(Date),
        })
      );
    });
  });
});
