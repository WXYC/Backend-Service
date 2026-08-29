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

  // BS#1969: the sendResetPassword hook extends an account-setup (incomplete
  // user) token well past better-auth's 1-hour reset default so DJs who act on
  // the setup email hours-to-days later aren't locked out. This is the roster
  // "Send Invite" resend path (a plain request-password-reset for an incomplete
  // user), distinct from provisionUser's own long-lived mint.
  test('extends the account-setup token for an incomplete user far beyond the 1h reset default', async () => {
    const resetRes = await fetch(`${authBaseUrl}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: frontendUrl },
      body: JSON.stringify({ email: INCOMPLETE_EMAIL, redirectTo: `${frontendUrl}/onboarding` }),
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
    const { token, expiresAt, createdAt } = await tokenRes.json();
    expect(token).toBeTruthy();

    const ttlMs = new Date(expiresAt).getTime() - new Date(createdAt).getTime();
    // A genuine reset lives 1 hour; the account-setup extension makes this one
    // much longer (default 7 days). > 2h proves the hook fired without pinning
    // the exact configured TTL.
    expect(ttlMs).toBeGreaterThan(2 * 60 * 60 * 1000);
  });
  async function requestInvite() {
    const res = await fetch(`${authBaseUrl}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: frontendUrl },
      body: JSON.stringify({ email: INCOMPLETE_EMAIL, redirectTo: `${frontendUrl}/onboarding` }),
    });
    if (!res.ok) {
      throw new Error(`request-password-reset failed: ${res.status} ${await res.text()}`);
    }
    const tokenRes = await fetch(
      `${authBaseUrl}/test/verification-token?identifier=${encodeURIComponent(INCOMPLETE_EMAIL)}&type=reset-password`
    );
    if (!tokenRes.ok) {
      throw new Error(`verification-token lookup failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    return tokenRes.json();
  }

  // Single-live-invite invariant. better-auth's resetPassword consumes only the
  // token it is handed and never sweeps a user's other outstanding rows, so
  // before this every roster "Send Invite" click left the previous link alive
  // for its full (now 30-day) TTL — a second working password-reset for the
  // same account. This is also the only place the revocation WHERE predicate is
  // exercised against real PostgreSQL; the unit suite can only prove that a
  // predicate was passed, not that it selects the right rows.
  test('a resent invite invalidates the previous link', async () => {
    const first = await requestInvite();
    expect(first.token).toBeTruthy();

    const second = await requestInvite();
    expect(second.token).toBeTruthy();
    expect(second.token).not.toBe(first.token);

    // the superseded link is dead on arrival
    const staleRes = await fetch(`${authBaseUrl}/wxyc/complete-onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: first.token, newPassword: 'StaleInvitePass1' }),
    });
    expect(staleRes.status).toBe(400);
    expect((await staleRes.json()).code).toBe('INVALID_TOKEN');

    // and the DJ can still onboard with the one they were just sent
    const freshRes = await fetch(`${authBaseUrl}/wxyc/complete-onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: second.token,
        newPassword: 'FreshInvitePass1',
        realName: 'Integration Test DJ',
        djName: 'DJ Integration',
      }),
    });
    if (!freshRes.ok) {
      throw new Error(`complete-onboarding failed: ${freshRes.status} ${await freshRes.text()}`);
    }
    expect(await freshRes.json()).toMatchObject({ status: true, userId: INCOMPLETE_USER_ID });
  });
});
