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

  // `getArtistCardById` collapses a multi-genre artist onto its lowest
  // `genre_id` crossreference row (BS#2156's documented design), but none of
  // the five dependent counts are genre-scoped -- they key on `artist_id`
  // alone, so a multi-genre artist's dependents must be reported in full
  // regardless of which genre the card collapsed to.
  it('does not collapse dependents for a multi-genre artist', async () => {
    const row = {
      release_count: 6,
      cross_reference_source_count: 1,
      cross_reference_target_count: 1,
      library_cross_reference_count: 2,
      compilation_credit_count: 7,
    };
    db.execute.mockResolvedValueOnce([row]);

    const result = await getArtistDependentCounts(7);

    expect(result).toEqual(row);
    // The query is keyed on the artist id alone -- one call regardless of how
    // many genre_artist_crossreference rows that artist carries.
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
