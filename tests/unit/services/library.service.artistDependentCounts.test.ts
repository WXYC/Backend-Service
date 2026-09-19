/**
 * Unit tests for `getArtistDependentCounts` (BS#2597) -- the delete-refusal
 * predicates WXYC/Backend-Service#2562 enforces, plus the informational
 * `compilation_credit_count`. Exported and tested independently of the
 * `getArtistCard` handler so BS#2562 can reuse it without a second
 * implementation.
 */
import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

import { getArtistDependentCounts } from '../../../apps/backend/services/library.service';

describe('getArtistDependentCounts (BS#2597)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is a single statement, not five round trips', async () => {
    db.execute.mockResolvedValueOnce([
      {
        release_count: 1,
        cross_reference_source_count: 2,
        cross_reference_target_count: 3,
        library_cross_reference_count: 4,
        compilation_credit_count: 5,
      },
    ]);

    await getArtistDependentCounts(42);

    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('returns all five counts from the single query result', async () => {
    const row = {
      release_count: 1,
      cross_reference_source_count: 2,
      cross_reference_target_count: 3,
      library_cross_reference_count: 4,
      compilation_credit_count: 5,
    };
    db.execute.mockResolvedValueOnce([row]);

    const result = await getArtistDependentCounts(42);

    expect(result).toEqual(row);
  });

  // Acceptance criterion: a fully deletable artist reports zeroes on every
  // field rather than omitting them -- the client should never need to treat
  // an absent count differently from an explicit zero.
  it('reports zero counts for an artist with no dependents at all', async () => {
    const zeroRow = {
      release_count: 0,
      cross_reference_source_count: 0,
      cross_reference_target_count: 0,
      library_cross_reference_count: 0,
      compilation_credit_count: 0,
    };
    db.execute.mockResolvedValueOnce([zeroRow]);

    const result = await getArtistDependentCounts(99);

    expect(result).toEqual(zeroRow);
  });

  // The multi-genre case -- `getArtistCardById` collapses a multi-genre
  // artist onto its lowest `genre_id` crossreference row (BS#2156's
  // documented design), but none of the five dependent counts are
  // genre-scoped -- lives in the integration tier
  // (`tests/integration/library.spec.js`, "does not collapse dependent
  // counts for a multi-genre artist"), where a real
  // `genre_artist_crossreference` row and a real cross-genre release can
  // actually exercise it. A version of this test used to live here, but with
  // `db.execute` mocked to resolve a single canned row it carried no genre
  // state at all -- it was mechanically identical to "returns all five
  // counts from the single query result" above with different numbers, and
  // could not have failed for the behavior its name claimed.
});
