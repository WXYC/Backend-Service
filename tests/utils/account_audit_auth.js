/**
 * Auth helpers for tests/integration/account-audit-event.spec.js (BS#2537,
 * parent epic #2534). Extracted (simplify pass, code review BS#2537 PR
 * #2545 follow-up, item 19) from that spec's own private copies, next to
 * the existing `tests/utils/better_auth.js` helper.
 *
 * Scoped to this ONE spec deliberately: eight other legacy integration
 * specs (admin-create-user-email-verify, auth-auto-membership,
 * check-request-ban, complete-onboarding-token, device-authorization,
 * station-signup, station-signup-admin, update-user-name-veto) carry their
 * own copy of `getAuthBaseUrl` (and, in one case, an equivalent sign-in
 * helper under a different name); consolidating those is a separate
 * follow-up, not part of this pass — see the PR body.
 */

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

async function signInAsStationManager(authBaseUrl) {
  const res = await fetch(`${authBaseUrl}/sign-in/username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_station_manager', password: 'testpassword123' }),
  });
  if (!res.ok) {
    throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie();
  if (!cookies || cookies.length === 0) {
    throw new Error('No session cookie returned by sign-in');
  }
  const cookie = cookies.map((c) => c.split(';')[0].trim()).join('; ');

  const sessionRes = await fetch(`${authBaseUrl}/get-session`, { headers: { Cookie: cookie } });
  const session = await sessionRes.json();
  return { cookie, managerId: session.user.id };
}

module.exports = { getAuthBaseUrl, signInAsStationManager };
