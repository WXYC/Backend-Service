/**
 * Unit tests for the config controller.
 */
import type { Request, Response } from 'express';

import { getConfig, getSecrets } from '../../../apps/backend/controllers/config.controller';
import { resetConfig as resetDonateConfig } from '../../../apps/backend/config/donate';

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
};

describe('config.controller', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // The donate flag factory caches on first read (module-scoped), so a test
    // that mutates process.env.DONATE_ENABLED needs the cache dropped or the
    // next getConfig() call serves a stale verdict from an earlier test.
    resetDonateConfig();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getConfig', () => {
    it('returns config values from environment variables', () => {
      process.env.POSTHOG_API_KEY = 'phc_test123';
      process.env.POSTHOG_HOST = 'https://custom.posthog.com';
      process.env.REQUEST_O_MATIC_URL = 'https://rom.example.com/request';
      process.env.API_BASE_URL = 'https://api.example.com';
      process.env.DONATE_URL = 'https://donate.example.com/wxyc';
      process.env.DONATE_ENABLED = 'true';

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        posthogApiKey: 'phc_test123',
        posthogHost: 'https://custom.posthog.com',
        requestOMaticUrl: 'https://rom.example.com/request',
        apiBaseUrl: 'https://api.example.com',
        donateUrl: 'https://donate.example.com/wxyc',
        donateEnabled: true,
      });
    });

    it('donateEnabled: unset DONATE_ENABLED evaluates to false', () => {
      delete process.env.DONATE_ENABLED;

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.donateEnabled).toBe(false);
    });

    it('donateEnabled: "true" evaluates to true', () => {
      process.env.DONATE_ENABLED = 'true';

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.donateEnabled).toBe(true);
    });

    it('donateEnabled: "TRUE" evaluates to false (strict === \'true\' comparison, not case-insensitive)', () => {
      process.env.DONATE_ENABLED = 'TRUE';

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.donateEnabled).toBe(false);
    });

    it('returns defaults when environment variables are not set', () => {
      delete process.env.POSTHOG_API_KEY;
      delete process.env.POSTHOG_HOST;
      delete process.env.REQUEST_O_MATIC_URL;
      delete process.env.API_BASE_URL;
      delete process.env.DONATE_URL;
      delete process.env.DONATE_ENABLED;

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        posthogApiKey: '',
        posthogHost: 'https://us.i.posthog.com',
        requestOMaticUrl: '',
        apiBaseUrl: 'https://api.wxyc.org',
        donateUrl: '',
        donateEnabled: false,
      });
    });

    it('sets Cache-Control header to public, max-age=3600', () => {
      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=3600');
    });

    it('does not include Discogs credentials', () => {
      process.env.DISCOGS_API_KEY = 'should_not_appear';
      process.env.DISCOGS_API_SECRET = 'should_not_appear';

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody).not.toHaveProperty('discogsApiKey');
      expect(responseBody).not.toHaveProperty('discogsApiSecret');
    });
  });

  describe('getSecrets', () => {
    it('returns Discogs credentials from environment variables', () => {
      process.env.DISCOGS_API_KEY = 'discogs_key_123';
      process.env.DISCOGS_API_SECRET = 'discogs_secret_456';

      const req = {} as Request;
      const res = createMockRes();

      getSecrets(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        discogsApiKey: 'discogs_key_123',
        discogsApiSecret: 'discogs_secret_456',
      });
    });

    it('returns empty strings when environment variables are not set', () => {
      delete process.env.DISCOGS_API_KEY;
      delete process.env.DISCOGS_API_SECRET;

      const req = {} as Request;
      const res = createMockRes();

      getSecrets(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        discogsApiKey: '',
        discogsApiSecret: '',
      });
    });

    it('sets Cache-Control header to private, max-age=3600', () => {
      const req = {} as Request;
      const res = createMockRes();

      getSecrets(req, res as Response, jest.fn());

      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
    });
  });
});
