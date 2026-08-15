/**
 * Unit tests for uncovered-release-list's antijoin.ts (BS#1877): the two
 * anti-joins (already-covered via album_critic_reviews, already-handed-off
 * via uncovered_release_search_markers) plus the pure combine. Mocked
 * `db.execute` — the real SQL shape (ANY(int[]) literal binding) is pinned
 * by the integration spec, mirroring
 * `album-critic-reviews-etl/antijoin.test.ts`.
 */
import { db } from '@wxyc/database';
import {
  loadCoveredLibraryIds,
  loadHandedOffLibraryIds,
  filterUncovered,
} from '../../../../jobs/uncovered-release-list/antijoin';
import type { CanonicalRelease } from '../../../../jobs/uncovered-release-list/rotation';

const mockExecute = db.execute as jest.Mock;

beforeEach(() => {
  mockExecute.mockReset();
});

describe('loadCoveredLibraryIds', () => {
  it('short-circuits to an empty set without a DB round-trip for empty input', async () => {
    const result = await loadCoveredLibraryIds([]);
    expect(result).toEqual(new Set());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns the distinct album_ids from album_critic_reviews as a Set', async () => {
    mockExecute.mockResolvedValueOnce([{ album_id: 1 }, { album_id: 3 }]);
    const result = await loadCoveredLibraryIds([1, 2, 3]);
    expect(result).toEqual(new Set([1, 3]));
  });
});

describe('loadHandedOffLibraryIds', () => {
  it('short-circuits to an empty set without a DB round-trip for empty input', async () => {
    const result = await loadHandedOffLibraryIds([]);
    expect(result).toEqual(new Set());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns the album_ids already present in uncovered_release_search_markers as a Set', async () => {
    mockExecute.mockResolvedValueOnce([{ album_id: 5 }]);
    const result = await loadHandedOffLibraryIds([5, 6]);
    expect(result).toEqual(new Set([5]));
  });
});

describe('filterUncovered', () => {
  const release = (libraryId: number): CanonicalRelease => ({
    libraryId,
    artist: `Artist ${libraryId}`,
    album: `Album ${libraryId}`,
  });

  it('drops releases present in either the covered set or the handed-off set', () => {
    const releases = [release(1), release(2), release(3), release(4)];
    const covered = new Set([1]);
    const handedOff = new Set([2]);

    const result = filterUncovered(releases, covered, handedOff);

    expect(result.map((r) => r.libraryId)).toEqual([3, 4]);
  });

  it('is a no-op when both sets are empty', () => {
    const releases = [release(1), release(2)];
    expect(filterUncovered(releases, new Set(), new Set())).toEqual(releases);
  });

  it('drops a release present in BOTH sets exactly once (no duplication in the surviving list)', () => {
    const releases = [release(1)];
    expect(filterUncovered(releases, new Set([1]), new Set([1]))).toEqual([]);
  });
});
