import { jest } from '@jest/globals';

// Jest defaults NODE_ENV to 'test' but some shells unset it; pin explicitly
// so the dev/test guards in route modules (e.g. the rate-limiter passthrough
// in apps/backend/routes/internal-bans.route.ts) consistently fire.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// SES has a 200-message/month quota; keep real sends off by default in the
// unit suite so a test that forgets to mock @aws-sdk/client-ses can't burn
// it. See shared/authentication/src/email.ts `isEmailSendingEnabled`.
process.env.EMAIL_ENABLED = process.env.EMAIL_ENABLED ?? 'false';

jest.setTimeout(10000);

beforeEach(() => {
  jest.clearAllMocks();
});
