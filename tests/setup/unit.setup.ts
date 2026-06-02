import { jest } from '@jest/globals';

// Jest defaults NODE_ENV to 'test' but some shells unset it; pin explicitly
// so the dev/test guards in route modules (e.g. the rate-limiter passthrough
// in apps/backend/routes/internal-bans.route.ts) consistently fire.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

jest.setTimeout(10000);

beforeEach(() => {
  jest.clearAllMocks();
});
