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
    process.env.SES_ACCESS_KEY_ID = 'test';
    process.env.SES_SECRET_ACCESS_KEY = 'test';
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
    process.env.SES_ACCESS_KEY_ID = 'test';
    process.env.SES_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.DEFAULT_ORG_NAME = 'WXYC';

    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.EMAIL_ENABLED;
  });

  it('calls the SES client send when EMAIL_ENABLED is unset (defaults to enabled, the production behavior)', async () => {
    delete process.env.EMAIL_ENABLED;
    const emailModule = await import('../../../shared/authentication/src/email');

    expect(emailModule.isEmailSendingEnabled()).toBe(true);

    // BS#1800: the original version of this test stopped at the boolean
    // helper check above and never drove sendEmail/asserted mockSend --
    // which meant it couldn't catch a real regression like the gate inside
    // sendEmail() being inverted (e.g. `if (isEmailSendingEnabled()) return;`),
    // which would silently disable all production email since unset is the
    // production default. Drive the real send path here too.
    await emailModule.sendEmail({
      type: 'passwordReset',
      to: 'user@example.com',
      url: 'https://example.com/reset',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
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

  it('resolves as a clean no-op when EMAIL_ENABLED=false and SES is entirely unconfigured (BS#1999)', async () => {
    // The disable switch must short-circuit BEFORE any SES config validation:
    // a deliberately email-less environment (dj-site E2E, local dev) sets
    // EMAIL_ENABLED=false without SES vars, and a config throw there is what
    // turned BS#1969's awaited invite send into emailSent:false on every
    // provision — failing dj-site's entire admin E2E suite.
    process.env.EMAIL_ENABLED = 'false';
    delete process.env.SES_FROM_EMAIL;
    delete process.env.SES_ACCESS_KEY_ID;
    delete process.env.SES_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
    const emailModule = await import('../../../shared/authentication/src/email');

    await expect(
      emailModule.sendEmail({
        type: 'accountSetup',
        to: 'newdj@test.wxyc.org',
        url: 'https://example.com/setup',
      })
    ).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
  });
});

/**
 * Credential resolution for the SES client.
 *
 * These keys are SES-only (IAM user `no-reply-sender`, policy
 * `no-reply-ses-sender-write-only`) but were read from `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` — the AWS SDK's RESERVED GLOBAL names. That put them
 * at the top of the default credential chain for the whole process, shadowing
 * the `wxyc-ec2-backend` instance role, so every other AWS SDK call that does
 * not pass explicit credentials ran as an SES-only user. Both CloudWatch
 * publishers failed `AccessDenied` on `cloudwatch:PutMetricData` for 105 days
 * and `WXYC/BackendService` never came into existence. See BS#2518.
 *
 * `SES_*` is therefore the name this credential must travel under. A
 * transitional `AWS_*` fallback carried the cutover and was deleted once prod
 * `~/.env` had been rewritten; the cases below pin that it stays deleted,
 * because restoring it re-opens the shadowing it existed to fix.
 *
 * `AWS_REGION` is deliberately NOT renamed: it carries no identity, so it
 * shadows nothing, and both CloudWatch clients read it with a correct
 * `|| 'us-east-1'` fallback.
 */
describe('SES credential resolution (BS#2518)', () => {
  const clearCredentialEnv = () => {
    delete process.env.SES_ACCESS_KEY_ID;
    delete process.env.SES_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  };

  const loadEmailModule = async () => {
    jest.clearAllMocks();
    jest.resetModules();
    const emailModule = await import('../../../shared/authentication/src/email');
    const sesModule = await import('@aws-sdk/client-ses');
    return { sendEmail: emailModule.sendEmail, SESClient: sesModule.SESClient as unknown as jest.Mock };
  };

  const send = (sendEmail: typeof import('../../../shared/authentication/src/email').sendEmail) =>
    sendEmail({ type: 'passwordReset', to: 'dj@test.wxyc.org', url: 'https://example.com/reset' });

  beforeEach(() => {
    process.env.SES_FROM_EMAIL = 'test@wxyc.org';
    process.env.AWS_REGION = 'us-east-1';
    process.env.DEFAULT_ORG_NAME = 'WXYC';
    process.env.EMAIL_ENABLED = 'true';
    clearCredentialEnv();
  });

  // Jest does not reset process.env between test FILES in a worker, and
  // tests/setup/unit.setup.ts only DEFAULTS EMAIL_ENABLED (`?? 'false'`), so a
  // value set here survives into every later file in the same worker. Leaving
  // it 'true' with the credential vars deleted would arm the email path in
  // suites that do not mock @aws-sdk/client-ses — tests/unit/auth/station-signup.test.ts
  // mocks none — so this restores both halves, not just its own.
  afterEach(() => {
    clearCredentialEnv();
    process.env.EMAIL_ENABLED = 'false';
    process.env.SES_ACCESS_KEY_ID = 'test';
    process.env.SES_SECRET_ACCESS_KEY = 'test';
    // AWS_* is deliberately NOT restored: it is no longer a credential source,
    // and leaving it set would trip `warnIfLegacyCredentialsPresent` in every
    // later file sharing this worker.
  });

  it('reads credentials from SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY', async () => {
    process.env.SES_ACCESS_KEY_ID = 'ses-key';
    process.env.SES_SECRET_ACCESS_KEY = 'ses-secret';
    const { sendEmail, SESClient } = await loadEmailModule();

    await send(sendEmail);

    expect(SESClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        credentials: { accessKeyId: 'ses-key', secretAccessKey: 'ses-secret' },
      })
    );
  });

  it('reads SES_* and ignores the reserved spelling when both are set', async () => {
    // Guards the inversion, not the fallback: a resolver that consulted AWS_*
    // first would still pass every other test in this block.
    process.env.SES_ACCESS_KEY_ID = 'ses-key';
    process.env.SES_SECRET_ACCESS_KEY = 'ses-secret';
    process.env.AWS_ACCESS_KEY_ID = 'aws-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    const { sendEmail, SESClient } = await loadEmailModule();

    await send(sendEmail);

    expect(SESClient).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { accessKeyId: 'ses-key', secretAccessKey: 'ses-secret' } })
    );
  });

  it('treats a half-set SES_* pair as a configuration error, not half a credential', async () => {
    // Both halves come from one spelling or the resolver yields null. An id
    // without its secret must fail loudly here rather than reach SES as a
    // partial credential, which authenticates as nothing and surfaces as an
    // opaque signature failure at send time.
    process.env.SES_ACCESS_KEY_ID = 'ses-key';
    const { sendEmail } = await loadEmailModule();

    await expect(send(sendEmail)).rejects.toThrow(/Missing SES configuration/);
  });

  it('throws naming only the SES_* spelling when no credentials are set', async () => {
    const { sendEmail } = await loadEmailModule();

    await expect(send(sendEmail)).rejects.toThrow(/SES_ACCESS_KEY_ID.*SES_SECRET_ACCESS_KEY.*AWS_REGION/s);
    // Naming the reserved spelling in the remedy is how an operator re-arms the
    // shadowing this removal closed, so the message must not offer it.
    await expect(send(sendEmail)).rejects.not.toThrow(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  });

  it('no longer accepts the legacy AWS_* pair', async () => {
    // The regression guarded here: restoring the fallback re-opens the
    // credential-chain shadowing that kept WXYC/BackendService from existing
    // for 105 days. AWS_* alone must be a configuration error, never a send.
    process.env.AWS_ACCESS_KEY_ID = 'aws-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    const { sendEmail, SESClient } = await loadEmailModule();

    await expect(send(sendEmail)).rejects.toThrow(/Missing SES configuration/);
    expect(SESClient).not.toHaveBeenCalled();
  });

  it('warns once, not once per send, while the reserved AWS_ACCESS_KEY_ID is set', async () => {
    // Deleting the fallback does not delete the hazard: the variable being SET
    // is what tops the default credential chain, whatever this module reads.
    // Unobservability is what let BS#2518 run dark, so the detector outlives
    // the fallback it shipped with.
    //
    // The unconfigured-SES path is the one that PINS the once-only guard.
    // `getSesClient` memoizes only on success, so a succeeding send reaches
    // `resolveSesCredentials` exactly once and would pass whether or not the
    // guard exists. Here every send re-enters the resolver, so a missing guard
    // warns twice — and this is the shape that matters, since a re-armed
    // AWS_ACCESS_KEY_ID with no SES_* is precisely the misconfiguration.
    process.env.AWS_ACCESS_KEY_ID = 'aws-key';
    const { sendEmail } = await loadEmailModule();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(send(sendEmail)).rejects.toThrow(/Missing SES configuration/);
    await expect(send(sendEmail)).rejects.toThrow(/Missing SES configuration/);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/shadows the EC2 instance role/);
    warn.mockRestore();
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
