/**
 * Pins the user-visible outcome of BS#2764 at the `processRequest` level:
 * when the LML lookup coordinator behind the song-as-artist strategy
 * rejects, the request still reaches Slack and `processRequest` resolves
 * rather than rejecting.
 *
 * `tests/unit/services/requestLine.service.test.ts` mocks
 * `executeSearchPipeline` wholesale, which can't exercise this -- the bug
 * this guards against lives inside the pipeline's song-as-artist strategy.
 * This file instead runs the REAL search pipeline and the REAL
 * `executeSongAsArtist` strategy (matching `requestLine.enhanced.service.ts`'s
 * actual wiring, where `discogsService.searchReleasesByArtist` calls
 * `lmlLookupCoordinator.lookup`), with only the library search and the LML
 * coordinator and Slack poster mocked.
 */
import { jest } from '@jest/globals';

// Mock AI parsing so the parsed request is fully controlled: a song with no
// artist is what drives the pipeline into the song-as-artist strategy
// (`shouldRunSongAsArtist`).
const mockParseRequest = jest.fn();
jest.mock('../../../../apps/backend/services/ai/index', () => ({
  parseRequest: mockParseRequest,
  isParserAvailable: jest.fn().mockReturnValue(true),
}));

// Library search: force every direct-match step to find nothing, so the
// pipeline falls through to the song-as-artist strategy's Discogs/LML branch.
jest.mock('../../../../apps/backend/services/library.service', () => ({
  searchLibrary: jest.fn().mockResolvedValue([]),
  filterResultsByArtist: jest.fn().mockReturnValue([]),
  searchAlbumsByTitle: jest.fn().mockResolvedValue([]),
  findSimilarArtist: jest.fn().mockResolvedValue(null),
}));

// The LML lookup coordinator `requestLine.enhanced.service.ts` wires into
// `discogsService.searchReleasesByArtist` -- rejecting here is the failure
// this test proves no longer escapes the song-as-artist strategy.
const mockLmlLookup = jest.fn();
jest.mock('../../../../apps/backend/services/lml/index', () => ({
  lmlLookupCoordinator: { lookup: mockLmlLookup },
}));

// Artwork + its providers aren't exercised (no library results), but are
// mocked wholesale to avoid pulling in the NSFW classifier / provider
// clients -- mirrors requestLine.service.test.ts.
jest.mock('../../../../apps/backend/services/artwork/index', () => ({
  fetchArtworkForItems: jest.fn(),
}));
jest.mock('../../../../apps/backend/services/artwork/providers/index', () => ({
  discogsProvider: { searchReleasesByTrack: jest.fn() },
}));

// Slack: the assertion surface for this test.
const mockPostBlocksToSlack = jest.fn();
jest.mock('../../../../apps/backend/services/slack/index', () => ({
  buildSlackBlocks: jest.fn().mockReturnValue([]),
  buildSimpleSlackBlocks: jest.fn().mockReturnValue([]),
  postBlocksToSlack: mockPostBlocksToSlack,
  postTextToSlack: jest.fn(),
}));

import { processRequest } from '../../../../apps/backend/services/requestLine/requestLine.enhanced.service';
import { MessageType } from '../../../../apps/backend/services/requestLine/types';

describe('processRequest (BS#2764 song-as-artist outcome)', () => {
  const originalLibraryMetadataUrl = process.env.LIBRARY_METADATA_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    // `isLmlConfigured()` (real @wxyc/lml-client) gates whether
    // requestLine.enhanced.service.ts builds a `discogsService` at all --
    // without this, the song-as-artist strategy never gets a Discogs
    // service and the LML coordinator mock is never reached.
    process.env.LIBRARY_METADATA_URL = 'http://lml.test.invalid';

    mockParseRequest.mockResolvedValue({
      song: 'Changer',
      album: null,
      artist: null,
      isRequest: true,
      messageType: MessageType.REQUEST,
      rawMessage: 'Can you play Changer?',
    });
    mockPostBlocksToSlack.mockResolvedValue({ success: true, message: 'posted' });
  });

  afterEach(() => {
    if (originalLibraryMetadataUrl === undefined) {
      delete process.env.LIBRARY_METADATA_URL;
    } else {
      process.env.LIBRARY_METADATA_URL = originalLibraryMetadataUrl;
    }
  });

  it('still posts to Slack and resolves when the song-as-artist LML lookup rejects', async () => {
    mockLmlLookup.mockRejectedValue(new Error('LML request failed'));

    const result = await processRequest({ message: 'Can you play Changer?' });

    // Proves the real pipeline actually ran the real song-as-artist
    // strategy (not a pass-through mock) and reached the LML coordinator.
    expect(mockLmlLookup).toHaveBeenCalled();
    expect(result.searchType).toBe('song_as_artist');
    expect(result.libraryResults).toEqual([]);

    // The user-visible outcome: the request still reaches Slack ...
    expect(mockPostBlocksToSlack).toHaveBeenCalled();
    expect(result.result).toEqual({ success: true, message: 'posted' });
    // ... and `processRequest` resolves rather than rejecting.
    expect(result.success).toBe(true);
  });
});
