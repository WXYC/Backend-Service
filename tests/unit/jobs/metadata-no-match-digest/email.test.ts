/**
 * Unit tests for metadata-no-match-digest/email.ts -- the self-contained SES
 * sender. Mirrors tests/unit/services/email.test.ts's mocking shape
 * (`@aws-sdk/client-ses` mocked before import; env reset + module reset per
 * test) since this job's `email.ts` mirrors that module's `getSesClient` /
 * `isEmailSendingEnabled` / config-set handling verbatim, deliberately
 * without importing `@wxyc/authentication` (see plan: that would drag
 * better-auth into the cron image). No test in this file makes a live SES
 * call -- `mockSend` never touches the network.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockSend = jest.fn().mockResolvedValue({} as never);
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  SendEmailCommand: jest.fn().mockImplementation((params) => params),
}));

describe('email.ts', () => {
  let sendDigestEmail: typeof import('../../../../jobs/metadata-no-match-digest/email').sendDigestEmail;
  let resolveDigestRecipient: typeof import('../../../../jobs/metadata-no-match-digest/email').resolveDigestRecipient;
  let SendEmailCommand: jest.Mock;

  const content = {
    subject: 'WXYC metadata gaps: 2 playcuts with no match — 2026-07-31',
    html: '<p>hi</p>',
    text: 'hi',
  };

  beforeEach(async () => {
    process.env.SES_FROM_EMAIL = 'test@wxyc.org';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.DIGEST_RECIPIENT_EMAIL;
    delete process.env.SES_CONFIGURATION_SET_NAME;

    jest.clearAllMocks();
    jest.resetModules();

    const mod = await import('../../../../jobs/metadata-no-match-digest/email');
    sendDigestEmail = mod.sendDigestEmail;
    resolveDigestRecipient = mod.resolveDigestRecipient;
    const ses = await import('@aws-sdk/client-ses');
    SendEmailCommand = ses.SendEmailCommand as unknown as jest.Mock;
  });

  describe('resolveDigestRecipient', () => {
    it('defaults to jake@wxyc.org when DIGEST_RECIPIENT_EMAIL is unset', () => {
      expect(resolveDigestRecipient()).toBe('jake@wxyc.org');
    });

    it('uses DIGEST_RECIPIENT_EMAIL when set', () => {
      process.env.DIGEST_RECIPIENT_EMAIL = 'ops@wxyc.org';
      expect(resolveDigestRecipient()).toBe('ops@wxyc.org');
    });
  });

  describe('sendDigestEmail', () => {
    it('sends to the given recipient with UTF-8-charset subject/html/text and returns true', async () => {
      const result = await sendDigestEmail('jake@wxyc.org', content);

      expect(result).toBe(true);
      expect(SendEmailCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Source: 'test@wxyc.org',
          Destination: { ToAddresses: ['jake@wxyc.org'] },
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

    it('passes ConfigurationSetName when SES_CONFIGURATION_SET_NAME is set', async () => {
      process.env.SES_CONFIGURATION_SET_NAME = 'my-first-configuration-set';
      jest.resetModules();
      const mod = await import('../../../../jobs/metadata-no-match-digest/email');
      const ses = await import('@aws-sdk/client-ses');
      const FreshCommand = ses.SendEmailCommand as unknown as jest.Mock;

      await mod.sendDigestEmail('jake@wxyc.org', content);

      expect(FreshCommand).toHaveBeenCalledWith(
        expect.objectContaining({ ConfigurationSetName: 'my-first-configuration-set' })
      );
    });

    it('omits ConfigurationSetName when unset', async () => {
      await sendDigestEmail('jake@wxyc.org', content);

      const callArgs = SendEmailCommand.mock.calls[0][0] as { ConfigurationSetName?: unknown };
      expect(callArgs.ConfigurationSetName).toBeUndefined();
    });

    it('throws when SES_FROM_EMAIL is not configured', async () => {
      delete process.env.SES_FROM_EMAIL;
      jest.resetModules();
      const mod = await import('../../../../jobs/metadata-no-match-digest/email');

      await expect(mod.sendDigestEmail('jake@wxyc.org', content)).rejects.toThrow('SES_FROM_EMAIL');
    });

    it('returns false and never calls SESClient.send when EMAIL_ENABLED=false (mock/disabled path -- no live SES call)', async () => {
      process.env.EMAIL_ENABLED = 'false';
      jest.resetModules();
      const mod = await import('../../../../jobs/metadata-no-match-digest/email');

      const result = await mod.sendDigestEmail('jake@wxyc.org', content);

      expect(result).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns false (never throws) when disabled even if SES_FROM_EMAIL is missing -- disabled is a clean no-op', async () => {
      process.env.EMAIL_ENABLED = 'false';
      delete process.env.SES_FROM_EMAIL;
      jest.resetModules();
      const mod = await import('../../../../jobs/metadata-no-match-digest/email');

      await expect(mod.sendDigestEmail('jake@wxyc.org', content)).resolves.toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('isEmailSendingEnabled() reports false for EMAIL_ENABLED=false', async () => {
      process.env.EMAIL_ENABLED = 'false';
      jest.resetModules();
      const mod = await import('../../../../jobs/metadata-no-match-digest/email');
      expect(mod.isEmailSendingEnabled()).toBe(false);
    });

    it('isEmailSendingEnabled() defaults to true (production behavior) when EMAIL_ENABLED is unset', async () => {
      delete process.env.EMAIL_ENABLED;
      jest.resetModules();
      const mod = await import('../../../../jobs/metadata-no-match-digest/email');
      expect(mod.isEmailSendingEnabled()).toBe(true);
    });

    it('calls SESClient.send exactly once when EMAIL_ENABLED=true', async () => {
      await sendDigestEmail('jake@wxyc.org', content);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });
});
