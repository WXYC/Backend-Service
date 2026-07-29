/**
 * Unit tests for uncovered-release-list's rotation.ts (BS#1877).
 *
 * `fetchActiveRotationRows` and `fetchCanonicalLibraryFields` (exercised
 * indirectly through `resolveCanonicalRelease`) issue raw `db.execute(sql\`...\`)`
 * reads — mocked here via `@wxyc/database`'s jest module mapper, the same
 * pattern `album-critic-reviews-etl/antijoin.test.ts` uses. `resolveLinkedAlbumId`
 * is mocked the same way `match.test.ts` mocks it. The COALESCE join's SQL
 * shape itself (real Postgres) is pinned by the integration spec, not here.
 */
import { db, resolveLinkedAlbumId } from '@wxyc/database';
import {
  fetchActiveRotationRows,
  resolveCanonicalRelease,
  dedupeByLibraryId,
  type RotationRow,
  type CanonicalRelease,
} from '../../../../jobs/uncovered-release-list/rotation';

const mockExecute = db.execute as jest.Mock;
const mockResolve = resolveLinkedAlbumId as jest.MockedFunction<typeof resolveLinkedAlbumId>;

beforeEach(() => {
  mockExecute.mockReset();
  mockResolve.mockReset();
});

describe('fetchActiveRotationRows', () => {
  it('maps raw rows, COALESCE-driven library_id/artist_name/album_title fields intact', async () => {
    mockExecute.mockResolvedValueOnce([
      { rotation_id: 1, library_id: 42, artist_name: 'Tony Allen', album_title: 'What goes up' },
      { rotation_id: 2, library_id: null, artist_name: 'Setting', album_title: 'Setting' },
    ]);

    const rows = await fetchActiveRotationRows();

    expect(rows).toEqual<RotationRow[]>([
      { rotationId: 1, libraryId: 42, artistName: 'Tony Allen', albumTitle: 'What goes up' },
      { rotationId: 2, libraryId: null, artistName: 'Setting', albumTitle: 'Setting' },
    ]);
  });

  it('drops a defensive-only row missing both artist_name and album_title', async () => {
    mockExecute.mockResolvedValueOnce([
      { rotation_id: 1, library_id: null, artist_name: null, album_title: null },
      { rotation_id: 2, library_id: 7, artist_name: 'Real Artist', album_title: 'Real Album' },
    ]);

    const rows = await fetchActiveRotationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].rotationId).toBe(2);
  });

  it('supports the node-postgres { rows } driver shape as well as a bare array', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ rotation_id: 5, library_id: 9, artist_name: 'A', album_title: 'B' }],
    });

    const rows = await fetchActiveRotationRows();
    expect(rows).toEqual([{ rotationId: 5, libraryId: 9, artistName: 'A', albumTitle: 'B' }]);
  });
});

describe('resolveCanonicalRelease', () => {
  it('for an already-linked row, returns the COALESCE-supplied fields directly with zero DB calls', async () => {
    const row: RotationRow = { rotationId: 1, libraryId: 42, artistName: 'Tony Allen', albumTitle: 'What goes up' };

    const release = await resolveCanonicalRelease(row);

    expect(release).toEqual<CanonicalRelease>({ libraryId: 42, artist: 'Tony Allen', album: 'What goes up' });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('for a snapshot-only row, resolves via resolveLinkedAlbumId then fetches canonical library fields for the resolved id', async () => {
    const row: RotationRow = { rotationId: 2, libraryId: null, artistName: 'Setting', albumTitle: 'Setting' };
    mockResolve.mockResolvedValueOnce(99);
    mockExecute.mockResolvedValueOnce([{ library_id: 99, album_title: 'Setting (canonical)', artist_name: 'Setting' }]);

    const release = await resolveCanonicalRelease(row);

    expect(mockResolve).toHaveBeenCalledWith('Setting', 'Setting');
    expect(release).toEqual<CanonicalRelease>({ libraryId: 99, artist: 'Setting', album: 'Setting (canonical)' });
  });

  it('returns null for a snapshot-only row that resolveLinkedAlbumId cannot resolve, without a canonical-fields lookup', async () => {
    const row: RotationRow = { rotationId: 3, libraryId: null, artistName: 'Nobody', albumTitle: 'Nothing' };
    mockResolve.mockResolvedValueOnce(null);

    const release = await resolveCanonicalRelease(row);

    expect(release).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns null (defensively) if the resolved id somehow has no library row', async () => {
    const row: RotationRow = { rotationId: 4, libraryId: null, artistName: 'Ghost', albumTitle: 'Row' };
    mockResolve.mockResolvedValueOnce(123);
    mockExecute.mockResolvedValueOnce([]);

    const release = await resolveCanonicalRelease(row);
    expect(release).toBeNull();
  });
});

describe('dedupeByLibraryId', () => {
  it('drops nulls and collapses duplicate library ids to their first occurrence', () => {
    const a: CanonicalRelease = { libraryId: 1, artist: 'A', album: 'AA' };
    const b: CanonicalRelease = { libraryId: 2, artist: 'B', album: 'BB' };
    const aAgain: CanonicalRelease = { libraryId: 1, artist: 'A', album: 'AA' };

    const result = dedupeByLibraryId([a, null, b, aAgain]);

    expect(result).toEqual([a, b]);
  });

  it('returns an empty array for an all-null input', () => {
    expect(dedupeByLibraryId([null, null])).toEqual([]);
  });
});
