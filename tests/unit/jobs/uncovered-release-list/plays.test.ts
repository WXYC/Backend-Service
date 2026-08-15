/**
 * Unit tests for uncovered-release-list's plays.ts (BS#1877, the "widen the
 * candidate set" amendment). Scoped to canonical-field mapping and row
 * pass-through only, deliberately asserting no SQL shape: `db.execute` is
 * fully mocked, mirroring `rotation.test.ts`'s stated convention ("The
 * COALESCE join's SQL shape itself (real Postgres) is pinned by the
 * integration spec, not here").
 */
import { db } from '@wxyc/database';
import { fetchRecentPlays, fetchAllPlayedAlbums } from '../../../../jobs/uncovered-release-list/plays';
import type { CanonicalRelease } from '../../../../jobs/uncovered-release-list/rotation';

const mockExecute = db.execute as jest.Mock;

beforeEach(() => {
  mockExecute.mockReset();
});

describe('fetchRecentPlays', () => {
  it('maps raw rows to CanonicalRelease, dropping play_count', async () => {
    mockExecute.mockResolvedValueOnce([
      { library_id: 42, artist_name: 'Tony Allen', album_title: 'What goes up', play_count: 7 },
      { library_id: 99, artist_name: 'Setting', album_title: 'Setting', play_count: 3 },
    ]);

    const releases = await fetchRecentPlays(30);

    expect(releases).toEqual<CanonicalRelease[]>([
      { libraryId: 42, artist: 'Tony Allen', album: 'What goes up' },
      { libraryId: 99, artist: 'Setting', album: 'Setting' },
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for an empty result', async () => {
    mockExecute.mockResolvedValueOnce([]);
    expect(await fetchRecentPlays(30)).toEqual([]);
  });

  it('supports the node-postgres { rows } driver shape as well as a bare array', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ library_id: 5, artist_name: 'A', album_title: 'B', play_count: 1 }],
    });

    const releases = await fetchRecentPlays(30);
    expect(releases).toEqual([{ libraryId: 5, artist: 'A', album: 'B' }]);
  });
});

describe('fetchAllPlayedAlbums', () => {
  it('maps raw rows to CanonicalRelease, dropping play_count, with zero args', async () => {
    mockExecute.mockResolvedValueOnce([
      {
        library_id: 1,
        artist_name: 'Duke Ellington & John Coltrane',
        album_title: 'Duke Ellington & John Coltrane',
        play_count: 120,
      },
    ]);

    const releases = await fetchAllPlayedAlbums();

    expect(releases).toEqual<CanonicalRelease[]>([
      { libraryId: 1, artist: 'Duke Ellington & John Coltrane', album: 'Duke Ellington & John Coltrane' },
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for an empty result', async () => {
    mockExecute.mockResolvedValueOnce([]);
    expect(await fetchAllPlayedAlbums()).toEqual([]);
  });
});
