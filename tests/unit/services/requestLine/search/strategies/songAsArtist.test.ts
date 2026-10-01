/**
 * Unit tests for the song-as-artist search strategy (BS#2764).
 *
 * Pins three behaviors:
 *   - a thrown/rejected `discogsService.searchReleasesByArtist` degrades to
 *     "no Discogs releases found" (`[]`) instead of propagating, so a failed
 *     LML lookup reached through this strategy no longer fails the whole
 *     song request before it reaches Slack (mirrors the guard
 *     `trackOnCompilation.ts` already has around its own Discogs calls);
 *   - the degrade still keeps Sentry visibility for anything that ISN'T an
 *     expected LML failure, by re-running the same `shouldCaptureExpressError`
 *     classifier the express error handler uses: a rejecting `LmlClientError`
 *     (e.g. the BS#1748 `LimiterShedError`) stays quiet, exactly as it did
 *     before this catch existed, while a genuine bug is still captured;
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

// `@sentry/node`'s ESM namespace exports aren't configurable, so the whole
// module is mocked (rather than `jest.spyOn`) with every export but
// `captureException` left real -- same pattern as
// tests/unit/services/library.deleteAlbum.test.ts.
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => {
  const actual = jest.requireActual('@sentry/node');
  return { ...actual, captureException: mockCaptureException };
});

import { executeSongAsArtist } from '../../../../../../apps/backend/services/requestLine/search/strategies/songAsArtist';
import type { EnrichedLibraryResult } from '../../../../../../apps/backend/services/requestLine/types';
// `matching/index` is pure (no DB/env dependency), so it's exercised for
// real rather than mocked -- `MAX_SEARCH_RESULTS` here is the same constant
// the strategy itself imports, not a hard-coded stand-in.
import { MAX_SEARCH_RESULTS } from '../../../../../../apps/backend/services/requestLine/matching/index';
// Real `@wxyc/lml-client` classes: the unit suite's moduleNameMapper
// resolves this package to its TS source rather than a hand-written mock,
// and this file never jest.mock()s it, so `instanceof` checks against these
// hold exactly as they would against the error a real LML lookup-coordinator
// failure surfaces through this strategy's `discogsService` wrapper
// (requestLine.enhanced.service.ts).
import { LimiterShedError, LmlClientError } from '@wxyc/lml-client';
import { wxycExampleArtists, wxycExampleAlbums } from '@wxyc/shared/test-utils';

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
    ['rejects with LimiterShedError', () => Promise.reject(new LimiterShedError('shed_limiter_saturated'))],
    ['rejects with a generic Error', () => Promise.reject(new Error('LML request failed'))],
    ['resolves with no releases', () => Promise.resolve([])],
  ])('when searchReleasesByArtist %s', (_label, makeResult) => {
    it('resolves to [] without throwing', async () => {
      // "Changer" stands in for a listener's song-shaped request text here --
      // these cases only exercise how a search failure degrades, not whether
      // the string matches anything, so it's deliberately not the artist
      // name "Stereolab" the way the cross-reference test below needs it to be.
      const discogsService = { searchReleasesByArtist: jest.fn(makeResult) };

      await expect(executeSongAsArtist('Changer', discogsService)).resolves.toEqual([]);
    });
  });

  it('logs a [Search]-prefixed warning carrying the thrown error when searchReleasesByArtist throws', async () => {
    const shedError = new LimiterShedError('shed_breaker_open');
    const discogsService = {
      searchReleasesByArtist: jest.fn().mockRejectedValue(shedError),
    };

    await executeSongAsArtist('Changer', discogsService);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Search]'), shedError);
  });

  it('does not capture an LmlClientError-family rejection (e.g. LimiterShedError) to Sentry', async () => {
    const shedError = new LimiterShedError('shed_limiter_saturated');
    expect(shedError).toBeInstanceOf(LmlClientError);
    const discogsService = { searchReleasesByArtist: jest.fn().mockRejectedValue(shedError) };

    await executeSongAsArtist('Changer', discogsService);

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('captures a non-LML rejection to Sentry with level warning and the request-line tag, and still resolves []', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'album')");
    const discogsService = { searchReleasesByArtist: jest.fn().mockRejectedValue(bug) };

    await expect(executeSongAsArtist('Changer', discogsService)).resolves.toEqual([]);

    expect(mockCaptureException).toHaveBeenCalledWith(bug, {
      level: 'warning',
      tags: { subsystem: 'request-line' },
    });
  });

  it('returns a cross-referenced library row when Discogs resolves a matching release', async () => {
    // Canonical WXYC fixture (@wxyc/shared/test-utils) rather than a
    // hand-rolled artist/album pair.
    const {
      artist_name: artistName,
      code_letters: codeLetters,
      code_artist_number: codeArtistNumber,
    } = wxycExampleArtists.stereolab;
    const { album_title: albumTitle, code_number: codeNumber } = wxycExampleAlbums.aluminumTunes;

    const libraryRow: EnrichedLibraryResult = {
      id: 42,
      title: albumTitle,
      artist: artistName,
      alphabeticalName: artistName,
      codeLetters,
      codeArtistNumber,
      codeNumber,
      genre: 'Rock',
      format: 'CD',
      // <Genre> <Format> <Letters> <ArtistNum>/<ReleaseNum>, per the
      // `EnrichedLibraryResult.callNumber` doc comment in requestLine/types.ts.
      callNumber: `Rock CD ${codeLetters} ${codeArtistNumber}/${codeNumber}`,
      libraryUrl: 'http://www.wxyc.info/wxycdb/libraryRelease?id=42',
    };
    mockSearchAlbumsByTitle.mockResolvedValue([libraryRow]);

    const discogsService = {
      searchReleasesByArtist: jest.fn().mockResolvedValue([{ artist: artistName, album: albumTitle }]),
    };

    await expect(executeSongAsArtist(artistName, discogsService)).resolves.toEqual([libraryRow]);
    expect(mockSearchAlbumsByTitle).toHaveBeenCalledWith(albumTitle, MAX_SEARCH_RESULTS);
  });
});
