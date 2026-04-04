import { jest } from '@jest/globals';

// Mock https module (used by the production Slack path)
const mockRequest = jest.fn();
jest.mock('https', () => ({ request: mockRequest }));

// Mock the builder module
jest.mock('../../../apps/backend/services/slack/builder', () => ({}));

// Save original env
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  // Reset env to a clean state
  delete process.env.USE_MOCK_SERVICES;
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WXYC_REQUESTS_WEBHOOK;
  delete process.env.SIMULATE_SLACK_FAILURE;
});

afterAll(() => {
  Object.assign(process.env, originalEnv);
});

describe('SLACK_WEBHOOK_URL override', () => {
  // Dynamic import so env vars are read fresh
  async function importSlackService() {
    // Clear module cache so env vars are re-read
    jest.resetModules();
    return await import('../../../apps/backend/services/slack/slack.service');
  }

  describe('when SLACK_WEBHOOK_URL is set', () => {
    it('uses fetch() instead of https.request for postTextToSlack', async () => {
      process.env.SLACK_WEBHOOK_URL = 'http://mock-api:9090';
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('ok'),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { postTextToSlack } = await importSlackService();
      const result = await postTextToSlack('Hello from test');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://mock-api:9090/services/T00/B00/test',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
      expect(result.success).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('uses fetch() for postBlocksToSlack', async () => {
      process.env.SLACK_WEBHOOK_URL = 'http://mock-api:9090';
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('ok'),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { postBlocksToSlack } = await importSlackService();
      const result = await postBlocksToSlack([{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }], 'fallback');

      expect(mockFetch).toHaveBeenCalled();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://mock-api:9090/services/T00/B00/test');
      const body = JSON.parse(init.body as string);
      expect(body.blocks).toBeDefined();
      expect(body.text).toBe('fallback');
      expect(result.success).toBe(true);
    });

    it('returns failure when fetch responds with non-200', async () => {
      process.env.SLACK_WEBHOOK_URL = 'http://mock-api:9090';
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('internal server error'),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const { postTextToSlack } = await importSlackService();
      const result = await postTextToSlack('test');

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
    });

    it('handles fetch network error', async () => {
      process.env.SLACK_WEBHOOK_URL = 'http://mock-api:9090';
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      global.fetch = mockFetch as unknown as typeof fetch;

      const { postTextToSlack } = await importSlackService();
      await expect(postTextToSlack('test')).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('when SLACK_WEBHOOK_URL is not set', () => {
    it('falls back to https.request', async () => {
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      // Simulate https.request completing successfully
      mockRequest.mockImplementation((_config: unknown, callback: (res: unknown) => void) => {
        const res = {
          statusCode: 200,
          on: jest.fn((event: string, handler: (data?: string) => void) => {
            if (event === 'data') handler('ok');
            if (event === 'end') handler();
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          setTimeout: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const { postTextToSlack } = await importSlackService();
      const result = await postTextToSlack('test');

      expect(mockRequest).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('when SLACK_WEBHOOK_URL is malformed', () => {
    it('falls back to https.request if URL does not start with http', async () => {
      process.env.SLACK_WEBHOOK_URL = 'not-a-url';
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      mockRequest.mockImplementation((_config: unknown, callback: (res: unknown) => void) => {
        const res = {
          statusCode: 200,
          on: jest.fn((event: string, handler: (data?: string) => void) => {
            if (event === 'data') handler('ok');
            if (event === 'end') handler();
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          setTimeout: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const { postTextToSlack } = await importSlackService();
      const result = await postTextToSlack('test');

      expect(mockRequest).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('isSlackConfigured', () => {
    it('returns true when SLACK_WEBHOOK_URL is set', async () => {
      process.env.SLACK_WEBHOOK_URL = 'http://mock-api:9090';
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      const { isSlackConfigured } = await importSlackService();
      expect(isSlackConfigured()).toBe(true);
    });

    it('returns true when only SLACK_WXYC_REQUESTS_WEBHOOK is set', async () => {
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      const { isSlackConfigured } = await importSlackService();
      expect(isSlackConfigured()).toBe(true);
    });

    it('returns false when USE_MOCK_SERVICES is true', async () => {
      process.env.USE_MOCK_SERVICES = 'true';
      process.env.SLACK_WXYC_REQUESTS_WEBHOOK = '/services/T00/B00/test';

      const { isSlackConfigured } = await importSlackService();
      expect(isSlackConfigured()).toBe(false);
    });
  });
});
