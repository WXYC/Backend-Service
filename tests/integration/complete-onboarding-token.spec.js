/**
 * Integration test for invite-token onboarding completion.
 *
 * Mints a real better-auth reset-password verification row via
 * requestPasswordReset, resolves it through /auth/wxyc/complete-onboarding,
 * and verifies the `reset-password:${token}` storage contract end-to-end.
 */

const INCOMPLETE_EMAIL = 'test_incomplete@wxyc.org';
const INCOMPLETE_USER_ID = 'test-incomplete-id-0000000000001';

function getAuthBaseUrl() {
  if (process.env.BETTER_AUTH_URL) {
    try {
      return new URL(process.env.BETTER_AUTH_URL).toString().replace(/\/$/, '');
    } catch {
      // fall through
    }
  }
  const host = process.env.AUTH_HOST || 'localhost';
  const port = process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083;
  return `http://${host}:${port}/auth`;
}

describe('POST /auth/wxyc/complete-onboarding invite-token flow', () => {
  const authBaseUrl = getAuthBaseUrl();
  const frontendUrl = process.env.FRONTEND_SOURCE || 'http://localhost:3000';

  afterEach(async () => {
    const resetRes = await fetch(`${authBaseUrl}/test/reset-incomplete-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: INCOMPLETE_USER_ID }),
    });
    if (!resetRes.ok) {
      throw new Error(`reset-incomplete-user failed: ${resetRes.status} ${await resetRes.text()}`);
    }
  });

  test('completes onboarding with a token minted by requestPasswordReset', async () => {
    const resetRes = await fetch(`${authBaseUrl}/request-password-reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: frontendUrl,
      },
      body: JSON.stringify({
        email: INCOMPLETE_EMAIL,
        redirectTo: `${frontendUrl}/onboarding`,
      }),
    });
    if (!resetRes.ok) {
      throw new Error(`request-password-reset failed: ${resetRes.status} ${await resetRes.text()}`);
    }

    const tokenRes = await fetch(
      `${authBaseUrl}/test/verification-token?identifier=${encodeURIComponent(INCOMPLETE_EMAIL)}&type=reset-password`
    );
    if (!tokenRes.ok) {
      throw new Error(`verification-token lookup failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const { token } = await tokenRes.json();
    expect(token).toBeTruthy();

    const completeRes = await fetch(`${authBaseUrl}/wxyc/complete-onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        newPassword: 'NewOnboardingPass1',
        realName: 'Integration Test DJ',
        djName: 'DJ Integration',
      }),
    });
    if (!completeRes.ok) {
      throw new Error(`complete-onboarding failed: ${completeRes.status} ${await completeRes.text()}`);
    }

    const body = await completeRes.json();
    expect(body).toMatchObject({
      status: true,
      userId: INCOMPLETE_USER_ID,
      email: INCOMPLETE_EMAIL,
      username: 'test_incomplete',
    });
  });
});
