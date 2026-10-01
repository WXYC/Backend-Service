/**
 * Unit tests for the song-as-artist search strategy (BS#2764).
 *
 * Pins two behaviors:
 *   - a thrown/rejected `discogsService.searchReleasesByArtist` degrades to
 *     "no Discogs releases found" (`[]`) instead of propagating, so a failed
 *     LML lookup reached through this strategy no longer fails the whole
 *     song request before it reaches Slack (mirrors the guard
 *     `trackOnCompilation.ts` already has around its own Discogs calls);
 *   - the happy path -- a resolved Discogs release cross-referenced against
 *     a matching library row -- is unaffected by the new try/catch.
 */
import { jest } from '@jest/globals';

const mockSearchLibrary = jest.fn();
const mockFilterResultsByArtist = jest.fn();
const mockSearchAlbumsByTitle = jest.fn();
jest.mock('../../../../../../apps/backend/services/library.service', () => ({
  searchLibrary: mockSearchLibrary,
  filterResultsByArtist: mockFilterResultsByArtist,
  searchAlbumsByTitle: mockSearchAlbumsByTitle,
}));

const mockIsCompilationArtist = jest.fn();
jest.mock('../../../../../../apps/backend/services/requestLine/matching/index', () => ({
  isCompilationArtist: mockIsCompilationArtist,
  MAX_SEARCH_RESULTS: 5,
}));

import { executeSongAsArtist } from '../../../../../../apps/backend/services/requestLine/search/strategies/songAsArtist';
import type { EnrichedLibraryResult } from '../../../../../../apps/backend/services/requestLine/types';

// Faithful stand-in for the `LimiterShedError` the LML limiter (BS#1748) can
// surface through the lookup coordinator this strategy's `discogsService`
// wraps -- mirrors the fake used in
// tests/unit/services/lml/lookup-coordinator.test.ts rather than importing
// the real `@wxyc/lml-client` class into a test that has no other need of it.
class FakeLimiterShedError extends Error {
  constructor(public readonly reason: string) {
    super(`LML limiter shed: ${reason}`);
    this.name = 'LimiterShedError';
  }
}

describe('executeSongAsArtist', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Step 1 (direct library search) never finds a match for these
    // fixtures, so every case below reaches the Discogs branch (step 2).
    mockSearchLibrary.mockResolvedValue([]);
    mockFilterResultsByArtist.mockReturnValue([]);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe.each<[string, () => Promise<Array<{ artist: string; album: string }>>]>([
    ['rejects with LimiterShedError', () => Promise.reject(new FakeLimiterShedError('shed_limiter_saturated'))],
    ['rejects with a generic Error', () => Promise.reject(new Error('LML request failed'))],
    ['resolves with no releases', () => Promise.resolve([])],
  ])('when searchReleasesByArtist %s', (_label, makeResult) => {
    it('resolves to [] without throwing', async () => {
      const discogsService = { searchReleasesByArtist: jest.fn(makeResult) };

      await expect(executeSongAsArtist('Stereolab', discogsService)).resolves.toEqual([]);
    });
  });

  it('logs a [Search]-prefixed warning when searchReleasesByArtist throws', async () => {
    const discogsService = {
      searchReleasesByArtist: jest.fn().mockRejectedValue(new FakeLimiterShedError('shed_breaker_open')),
    };

    await executeSongAsArtist('Stereolab', discogsService);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Search]'), expect.anything());
  });

  it('returns a cross-referenced library row when Discogs resolves a matching release', async () => {
    const libraryRow: EnrichedLibraryResult = {
      id: 42,
      title: 'Dots and Loops',
      artist: 'Stereolab',
      alphabeticalName: 'Stereolab',
      codeLetters: 'RO',
      codeArtistNumber: 12,
      codeNumber: 3,
      genre: 'Rock',
      format: 'CD',
      callNumber: 'RO CD 12/3',
      libraryUrl: 'http://www.wxyc.info/wxycdb/libraryRelease?id=42',
    };
    mockSearchAlbumsByTitle.mockResolvedValue([libraryRow]);
    mockIsCompilationArtist.mockReturnValue(false);

    const discogsService = {
      searchReleasesByArtist: jest.fn().mockResolvedValue([{ artist: 'Stereolab', album: 'Dots and Loops' }]),
    };

    await expect(executeSongAsArtist('Stereolab', discogsService)).resolves.toEqual([libraryRow]);
    expect(mockSearchAlbumsByTitle).toHaveBeenCalledWith('Dots and Loops', 5);
  });
});
