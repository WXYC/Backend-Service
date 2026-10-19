import { jest } from '@jest/globals';
import { getErrorReporter, setErrorReporter } from '@wxyc/observability';
import { createSpyReporter, useSpyReporter } from '../../utils/observability';

// @wxyc/authentication is built as both ESM and CJS (BS#3396): an app can register its reporter through
// one build of @wxyc/observability while the library resolves the other. This pins that a capture made
// inside the library reaches a reporter registered through a separately loaded copy of the barrel.

const mockCreateVerificationValue = jest.fn().mockResolvedValue(undefined as never);
jest.mock('../../../shared/authentication/src/auth.definition', () => ({
  auth: {
    $context: Promise.resolve({
      baseURL: 'https://api.wxyc.org/auth',
      internalAdapter: { createVerificationValue: (...args: unknown[]) => mockCreateVerificationValue(...args) },
    }),
  },
}));

const mockSendAccountSetupEmail = jest.fn().mockRejectedValue(new Error('ses down') as never);
jest.mock('../../../shared/authentication/src/email', () => ({
  sendAccountSetupEmail: (...args: unknown[]) => mockSendAccountSetupEmail(...args),
}));

jest.mock('../../../shared/authentication/src/revoke-account-setup-tokens', () => ({
  revokeOutstandingAccountSetupTokens: jest.fn().mockResolvedValue(0 as never),
}));

import { createAndSendAccountSetupInvite } from '../../../shared/authentication/src/account-setup';

const reporter = useSpyReporter();

/** The barrel as a second, separately loaded copy, as the CJS build would be beside the ESM one the app registers through. */
function loadBarrelCopy(): typeof import('@wxyc/observability') {
  let copy!: typeof import('@wxyc/observability');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    copy = require('@wxyc/observability');
  });
  return copy;
}

describe('@wxyc/authentication error reporting', () => {
  it('sends a capture to the reporter registered through @wxyc/observability', async () => {
    const result = await createAndSendAccountSetupInvite({
      userId: 'user-id-001',
      email: 'newdj@test.wxyc.org',
      redirectTo: 'https://dj.wxyc.org/onboarding',
    });

    expect(result.sent).toBe(false);
    expect(reporter.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'ses down' }),
      expect.objectContaining({ tags: { subsystem: 'account-setup-invite' } })
    );
  });

  it('sees a reporter registered through another copy of the barrel', async () => {
    const appCopy = loadBarrelCopy();
    const distinct = createSpyReporter();
    const previous = getErrorReporter();
    appCopy.setErrorReporter(distinct);
    try {
      expect(getErrorReporter()).toBe(distinct);
      await createAndSendAccountSetupInvite({
        userId: 'user-id-001',
        email: 'newdj@test.wxyc.org',
        redirectTo: 'https://dj.wxyc.org/onboarding',
      });
      expect(distinct.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'ses down' }),
        expect.objectContaining({ tags: { subsystem: 'account-setup-invite' } })
      );
      expect(reporter.captureException).not.toHaveBeenCalled();
    } finally {
      setErrorReporter(previous);
    }
  });
});
