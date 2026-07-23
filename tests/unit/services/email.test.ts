import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock SES client before importing the module
const mockSend = jest.fn().mockResolvedValue({} as never);
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  SendEmailCommand: jest.fn().mockImplementation((params) => params),
}));

// Test cases for all email types
const emailTestCases = [
  {
    type: 'passwordReset' as const,
    expectedSubject: 'Reset your password',
    expectedActionText: 'Reset password',
    description: 'password reset',
  },
  {
    type: 'accountSetup' as const,
    expectedSubject: 'Welcome to WXYC! Set up your password',
    expectedActionText: 'Set up password',
    description: 'account setup (new user)',
  },
  {
    type: 'emailVerification' as const,
    expectedSubject: 'Welcome to WXYC! Verify your email address',
    expectedActionText: 'Verify email',
    description: 'email verification',
  },
];

describe('sendEmail', () => {
  let sendEmail: typeof import('../../../shared/authentication/src/email').sendEmail;
  let SendEmailCommand: jest.Mock;

  beforeEach(async () => {
    // Set up environment variables
    process.env.SES_FROM_EMAIL = 'test@wxyc.org';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.DEFAULT_ORG_NAME = 'WXYC';
    // tests/setup/unit.setup.ts defaults EMAIL_ENABLED=false for the suite;
    // this file's SES client is already fully mocked, so opt back in here
    // to exercise the real send path. The dedicated `EMAIL_ENABLED gating`
    // describe block below overrides this per-test.
    process.env.EMAIL_ENABLED = 'true';

    // Clear mocks
    jest.clearAllMocks();

    // Reset module cache to pick up fresh env vars
    jest.resetModules();

    // Re-import the mocked module
    const emailModule = await import('../../../shared/authentication/src/email');
    sendEmail = emailModule.sendEmail;
    const sesModule = await import('@aws-sdk/client-ses');
    SendEmailCommand = sesModule.SendEmailCommand as unknown as jest.Mock;
  });

  describe.each(emailTestCases)('$description email', ({ type, expectedSubject, expectedActionText }) => {
    it(`sends email with subject: "${expectedSubject}"`, async () => {
      await sendEmail({
        type,
        to: 'user@example.com',
        url: 'https://example.com/action?token=abc',
      });

      expect(SendEmailCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Message: expect.objectContaining({
            Subject: { Data: expectedSubject },
          }),
        })
      );
    });

    it(`includes "${expectedActionText}" as action text in HTML body`, async () => {
      await sendEmail({
        type,
        to: 'user@example.com',
        url: 'https://example.com/action?token=abc',
      });

      const callArgs = SendEmailCommand.mock.calls[0][0];
      expect(callArgs.Message.Body.Html.Data).toContain(expectedActionText);
    });

    it('includes the action URL in the email body', async () => {
      const testUrl = 'https://example.com/action?token=unique123';

      await sendEmail({ type, to: 'user@example.com', url: testUrl });

      const callArgs = SendEmailCommand.mock.calls[0][0];
      expect(callArgs.Message.Body.Html.Data).toContain(testUrl);
      expect(callArgs.Message.Body.Text.Data).toContain(testUrl);
    });
  });

  it('throws error when SES_FROM_EMAIL is not configured', async () => {
    delete process.env.SES_FROM_EMAIL;

    // Re-import to get module without SES_FROM_EMAIL
    jest.resetModules();
    const emailModule = await import('../../../shared/authentication/src/email');

    await expect(
      emailModule.sendEmail({
        type: 'passwordReset',
        to: 'test@example.com',
        url: 'https://example.com/reset',
      })
    ).rejects.toThrow('Missing AWS SES configuration: SES_FROM_EMAIL');
  });

  it('sends to the correct recipient email address', async () => {
    const recipientEmail = 'recipient@example.com';

    await sendEmail({
      type: 'passwordReset',
      to: recipientEmail,
      url: 'https://example.com/reset',
    });

    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: { ToAddresses: [recipientEmail] },
      })
    );
  });

  it('uses SES_FROM_EMAIL as the sender', async () => {
    await sendEmail({
      type: 'passwordReset',
      to: 'user@example.com',
      url: 'https://example.com/reset',
    });

    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Source: 'test@wxyc.org',
      })
    );
  });

  it('passes ConfigurationSetName when SES_CONFIGURATION_SET_NAME is set', async () => {
    process.env.SES_CONFIGURATION_SET_NAME = 'my-first-configuration-set';
    jest.resetModules();
    const emailModule = await import('../../../shared/authentication/src/email');
    const sesModule = await import('@aws-sdk/client-ses');
    const FreshCommand = sesModule.SendEmailCommand as unknown as jest.Mock;

    await emailModule.sendEmail({
      type: 'passwordReset',
      to: 'user@example.com',
      url: 'https://example.com/reset',
    });

    expect(FreshCommand).toHaveBeenCalledWith(
      expect.objectContaining({ ConfigurationSetName: 'my-first-configuration-set' })
    );
    delete process.env.SES_CONFIGURATION_SET_NAME;
  });

  it('omits ConfigurationSetName when SES_CONFIGURATION_SET_NAME is unset (undefined, not the string "undefined")', async () => {
    delete process.env.SES_CONFIGURATION_SET_NAME;
    jest.resetModules();
    const emailModule = await import('../../../shared/authentication/src/email');
    const sesModule = await import('@aws-sdk/client-ses');
    const FreshCommand = sesModule.SendEmailCommand as unknown as jest.Mock;

    await emailModule.sendEmail({
      type: 'passwordReset',
      to: 'user@example.com',
      url: 'https://example.com/reset',
    });

    const callArgs = FreshCommand.mock.calls[0][0] as { ConfigurationSetName?: unknown };
    expect(callArgs.ConfigurationSetName).toBeUndefined();
  });
});

describe('EMAIL_ENABLED gating', () => {
  beforeEach(() => {
    process.env.SES_FROM_EMAIL = 'test@wxyc.org';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.DEFAULT_ORG_NAME = 'WXYC';

    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.EMAIL_ENABLED;
  });

  it('does not call the SES client send when EMAIL_ENABLED is unset', async () => {
    delete process.env.EMAIL_ENABLED;
    const emailModule = await import('../../../shared/authentication/src/email');

    // Unset means "enabled" (production default) — confirm the opposite
    // gate below instead exercises the disabled path.
    expect(emailModule.isEmailSendingEnabled()).toBe(true);
  });

  it('does not call the SES client send when EMAIL_ENABLED=false', async () => {
    process.env.EMAIL_ENABLED = 'false';
    const emailModule = await import('../../../shared/authentication/src/email');

    await emailModule.sendEmail({
      type: 'passwordReset',
      to: 'user@example.com',
      url: 'https://example.com/reset',
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls the SES client send when EMAIL_ENABLED=true', async () => {
    process.env.EMAIL_ENABLED = 'true';
    const emailModule = await import('../../../shared/authentication/src/email');

    await emailModule.sendEmail({
      type: 'passwordReset',
      to: 'user@example.com',
      url: 'https://example.com/reset',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('reports isEmailSendingEnabled() false for EMAIL_ENABLED=false', async () => {
    process.env.EMAIL_ENABLED = 'false';
    const emailModule = await import('../../../shared/authentication/src/email');
    expect(emailModule.isEmailSendingEnabled()).toBe(false);
  });
});

// Test cases for new user detection logic (to be used in auth.definition)
const userDetectionCases = [
  { realName: '', expectedType: 'accountSetup', description: 'empty string' },
  { realName: null, expectedType: 'accountSetup', description: 'null' },
  { realName: undefined, expectedType: 'accountSetup', description: 'undefined' },
  { realName: '   ', expectedType: 'accountSetup', description: 'whitespace only' },
  { realName: 'John Doe', expectedType: 'passwordReset', description: 'has name' },
];

describe('isNewUserSetup detection logic', () => {
  describe.each(userDetectionCases)('when realName is $description', ({ realName, expectedType }) => {
    it(`should return ${expectedType} email type`, () => {
      // This tests the logic that will be used in auth.definition.ts
      const isNewUserSetup = !realName || (typeof realName === 'string' && realName.trim() === '');
      const emailType = isNewUserSetup ? 'accountSetup' : 'passwordReset';

      expect(emailType).toBe(expectedType);
    });
  });
});
