/**
 * Unit tests for the config controller.
 */
import type { Request, Response } from 'express';

import { getConfig } from '../../../apps/backend/controllers/config.controller';

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.set = jest.fn().mockReturnValue(res) as unknown as Response['set'];
  return res;
};

describe('config.controller', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
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

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        posthogApiKey: 'phc_test123',
        posthogHost: 'https://custom.posthog.com',
        requestOMaticUrl: 'https://rom.example.com/request',
        apiBaseUrl: 'https://api.example.com',
      });
    });

    it('returns defaults when environment variables are not set', () => {
      delete process.env.POSTHOG_API_KEY;
      delete process.env.POSTHOG_HOST;
      delete process.env.REQUEST_O_MATIC_URL;
      delete process.env.API_BASE_URL;

      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        posthogApiKey: '',
        posthogHost: 'https://us.i.posthog.com',
        requestOMaticUrl: '',
        apiBaseUrl: 'https://api.wxyc.org',
      });
    });

    it('sets Cache-Control header to public, max-age=3600', () => {
      const req = {} as Request;
      const res = createMockRes();

      getConfig(req, res as Response, jest.fn());

      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=3600');
    });
  });
});
