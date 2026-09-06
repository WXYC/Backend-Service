/**
 * Unit tests for station-signup-review/email.ts -- the self-contained SES
 * sender. Mirrors tests/unit/jobs/metadata-no-match-digest/email.test.ts's
 * mocking shape verbatim: `@aws-sdk/client-ses` mocked before import, env
 * reset per test. No test here makes a live SES call.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockSend = jest.fn().mockResolvedValue({} as never);
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  SendEmailCommand: jest.fn().mockImplementation((params) => params),
}));

describe('email.ts', () => {
  let sendStationSignupDigestEmail: typeof import('../../../../jobs/station-signup-review/email').sendStationSignupDigestEmail;
  let resolveStationSignupRecipient: typeof import('../../../../jobs/station-signup-review/email').resolveStationSignupRecipient;
  let SendEmailCommand: jest.Mock;

  const content = {
    subject: 'WXYC station signup review: 2 pending — 2026-07-31',
    html: '<p>hi</p>',
    text: 'hi',
  };

  beforeEach(async () => {
    process.env.SES_FROM_EMAIL = 'test@wxyc.org';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.STATION_SIGNUP_ALERT_EMAIL;
    delete process.env.SES_CONFIGURATION_SET_NAME;

    jest.clearAllMocks();
    jest.resetModules();

    const mod = await import('../../../../jobs/station-signup-review/email');
    sendStationSignupDigestEmail = mod.sendStationSignupDigestEmail;
    resolveStationSignupRecipient = mod.resolveStationSignupRecipient;
    const ses = await import('@aws-sdk/client-ses');
    SendEmailCommand = ses.SendEmailCommand as unknown as jest.Mock;
  });

  describe('resolveStationSignupRecipient', () => {
    it('falls back to jake@wxyc.org when STATION_SIGNUP_ALERT_EMAIL is unset, and FLAGS the fallback', () => {
      // Falling back rather than throwing is deliberate: hard-failing here
      // would kill the safety-net digest during exactly the weeks nobody is
      // watching. The flag is what stops it becoming the silent permanent
      // configuration -- orchestrate.ts logs a warn on it and format.ts puts
      // a line in the digest body.
      expect(resolveStationSignupRecipient()).toEqual({ address: 'jake@wxyc.org', usedFallback: true });
    });

    it('uses STATION_SIGNUP_ALERT_EMAIL when set, with no fallback flag', () => {
      process.env.STATION_SIGNUP_ALERT_EMAIL = 'station-manager@wxyc.org';
      expect(resolveStationSignupRecipient()).toEqual({ address: 'station-manager@wxyc.org', usedFallback: false });
    });

    it('treats a whitespace-only value as unset, and flags the fallback', () => {
      process.env.STATION_SIGNUP_ALERT_EMAIL = '   ';
      expect(resolveStationSignupRecipient()).toEqual({ address: 'jake@wxyc.org', usedFallback: true });
    });
  });

  describe('sendStationSignupDigestEmail', () => {
    it('sends to the given recipient with UTF-8-charset subject/html/text and returns true', async () => {
      const result = await sendStationSignupDigestEmail('station-manager@wxyc.org', content);

      expect(result).toBe(true);
      expect(SendEmailCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Source: 'test@wxyc.org',
          Destination: { ToAddresses: ['station-manager@wxyc.org'] },
          Message: {
            Subject: { Data: content.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: content.text, Charset: 'UTF-8' },
              Html: { Data: content.html, Charset: 'UTF-8' },
            },
          },
        })
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('throws when SES_FROM_EMAIL is not configured', async () => {
      delete process.env.SES_FROM_EMAIL;
      jest.resetModules();
      const mod = await import('../../../../jobs/station-signup-review/email');

      await expect(mod.sendStationSignupDigestEmail('station-manager@wxyc.org', content)).rejects.toThrow(
        'SES_FROM_EMAIL'
      );
    });

    it('returns false and never calls SESClient.send when EMAIL_ENABLED=false', async () => {
      process.env.EMAIL_ENABLED = 'false';
      jest.resetModules();
      const mod = await import('../../../../jobs/station-signup-review/email');

      const result = await mod.sendStationSignupDigestEmail('station-manager@wxyc.org', content);

      expect(result).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns false (never throws) when disabled even if SES_FROM_EMAIL is missing', async () => {
      process.env.EMAIL_ENABLED = 'false';
      delete process.env.SES_FROM_EMAIL;
      jest.resetModules();
      const mod = await import('../../../../jobs/station-signup-review/email');

      await expect(mod.sendStationSignupDigestEmail('station-manager@wxyc.org', content)).resolves.toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('isEmailSendingEnabled() defaults to true when EMAIL_ENABLED is unset', async () => {
      delete process.env.EMAIL_ENABLED;
      jest.resetModules();
      const mod = await import('../../../../jobs/station-signup-review/email');
      expect(mod.isEmailSendingEnabled()).toBe(true);
    });
  });
});
