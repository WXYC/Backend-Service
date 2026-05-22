import { jest } from '@jest/globals';

// Mock Sentry
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

// Mock AI parser
const mockParseRequest = jest.fn();
const mockIsParserAvailable = jest.fn().mockReturnValue(true);
jest.mock('../../../apps/backend/services/ai/index', () => ({
  parseRequest: mockParseRequest,
  isParserAvailable: mockIsParserAvailable,
}));

// Mock config
jest.mock('../../../apps/backend/services/requestLine/config', () => ({
  getConfig: jest.fn().mockReturnValue({
    enableLibrarySearch: false,
    enableArtworkLookup: false,
  }),
  isParsingEnabled: jest.fn().mockReturnValue(true),
}));

// Mock search pipeline
jest.mock('../../../apps/backend/services/requestLine/search/index', () => ({
  executeSearchPipeline: jest.fn(),
  getSearchTypeFromState: jest.fn().mockReturnValue('none'),
}));

// Mock library service
jest.mock('../../../apps/backend/services/library.service', () => ({
  findSimilarArtist: jest.fn().mockResolvedValue(null),
}));

// Mock LML client
jest.mock('@wxyc/lml-client', () => ({
  searchTrackReleases: jest.fn(),
  validateTrackOnRelease: jest.fn(),
  isLmlConfigured: jest.fn().mockReturnValue(false),
}));

// Mock artwork
jest.mock('../../../apps/backend/services/artwork/index', () => ({
  fetchArtworkForItems: jest.fn(),
}));

// Mock artwork providers
jest.mock('../../../apps/backend/services/artwork/providers/index', () => ({
  discogsProvider: { searchReleasesByTrack: jest.fn() },
}));

// Mock Slack
const mockPostBlocksToSlack = jest.fn();
const mockPostTextToSlack = jest.fn();
jest.mock('../../../apps/backend/services/slack/index', () => ({
  buildSlackBlocks: jest.fn().mockReturnValue([]),
  buildSimpleSlackBlocks: jest.fn().mockReturnValue([]),
  postBlocksToSlack: mockPostBlocksToSlack,
  postTextToSlack: mockPostTextToSlack,
}));

// Mock matching constants
jest.mock('../../../apps/backend/services/requestLine/matching/index', () => ({
  MAX_SEARCH_RESULTS: 5,
}));

import { processRequest } from '../../../apps/backend/services/requestLine/requestLine.enhanced.service';
import { MessageType } from '../../../apps/backend/services/requestLine/types';

describe('requestLine.enhanced.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParseRequest.mockResolvedValue({
      song: 'VI Scose Poise',
      album: 'Confield',
      artist: 'Autechre',
      isRequest: true,
      messageType: MessageType.REQUEST,
      rawMessage: 'Can you play VI Scose Poise by Autechre?',
    });
  });

  it('reports Slack posting failure to Sentry with level warning', async () => {
    const slackError = new Error('Slack webhook 500');
    mockPostBlocksToSlack.mockRejectedValue(slackError);

    const result = await processRequest({
      message: 'Can you play VI Scose Poise by Autechre?',
    });

    expect(result.success).toBe(true);
    expect(result.result.success).toBe(false);
    expect(mockCaptureException).toHaveBeenCalledWith(
      slackError,
      expect.objectContaining({
        level: 'warning',
        tags: { subsystem: 'slack' },
      })
    );
  });
});
