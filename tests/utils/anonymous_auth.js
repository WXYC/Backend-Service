/**
 * Anonymous auth test utility
 * Authenticates with better-auth's anonymous sign-in endpoint and retrieves session token for testing
 */

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || 'http://localhost:8082/auth';

/**
 * Signs in as an anonymous user via better-auth.
 * Returns the session token and user info.
 *
 * @returns {Promise<{token: string, userId: string, user: object}>}
 */
async function signInAnonymous() {
  try {
    const response = await fetch(`${BETTER_AUTH_URL}/sign-in/anonymous`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anonymous sign-in failed: ${response.status} ${errorText}`);
    }

    // Extract session token from response header
    const token = response.headers.get('set-auth-token');

    if (!token) {
      // Some configurations may return the token in the body instead
      const body = await response.json();
      if (body.token) {
        return {
          token: body.token,
          userId: body.user?.id,
          user: body.user,
        };
      }
      throw new Error('No session token received from anonymous sign-in');
    }

    const body = await response.json();

    return {
      token,
      userId: body.user?.id,
      user: body.user,
    };
  } catch (error) {
    console.error(`Error connecting to better-auth service at ${BETTER_AUTH_URL}:`, error.message);
    throw error;
  }
}

/**
 * Gets a valid anonymous auth token for testing.
 * Convenience wrapper around signInAnonymous that returns just the token.
 *
 * @returns {Promise<string>} The session token
 */
async function getAnonymousToken() {
  const { token } = await signInAnonymous();
  return token;
}

/**
 * Bans an anonymous user via better-auth admin API.
 * Requires admin credentials to be set in AUTH_USERNAME and AUTH_PASSWORD env vars.
 *
 * @param {string} userId - The user ID to ban
 * @param {string} reason - The ban reason
 * @param {number} [expiresInSeconds] - Optional ban duration in seconds
 * @returns {Promise<void>}
 */
async function banUser(userId, reason, expiresInSeconds) {
  const adminToken = await getAdminToken();

  const body = {
    userId,
    banReason: reason,
  };

  if (expiresInSeconds) {
    body.banExpiresIn = expiresInSeconds;
  }

  const response = await fetch(`${BETTER_AUTH_URL}/admin/ban-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to ban user: ${response.status} ${errorText}`);
  }
}

/**
 * Unbans a user via better-auth admin API.
 * Requires admin credentials to be set in AUTH_USERNAME and AUTH_PASSWORD env vars.
 *
 * @param {string} userId - The user ID to unban
 * @returns {Promise<void>}
 */
async function unbanUser(userId) {
  const adminToken = await getAdminToken();

  const response = await fetch(`${BETTER_AUTH_URL}/admin/unban-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ userId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to unban user: ${response.status} ${errorText}`);
  }
}

/**
 * Gets an admin JWT token for admin operations.
 * Uses AUTH_USERNAME and AUTH_PASSWORD env vars.
 *
 * @returns {Promise<string>} Admin JWT token
 */
async function getAdminToken() {
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (!username || !password) {
    throw new Error('AUTH_USERNAME and AUTH_PASSWORD environment variables must be set for admin operations');
  }

  // Sign in as admin
  const signInResponse = await fetch(`${BETTER_AUTH_URL}/sign-in/username`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });

  if (!signInResponse.ok) {
    const errorText = await signInResponse.text();
    throw new Error(`Admin sign-in failed: ${signInResponse.status} ${errorText}`);
  }

  // Extract session cookies from response
  const cookies = signInResponse.headers.getSetCookie();

  if (!cookies || cookies.length === 0) {
    throw new Error('No session cookie received from admin sign-in');
  }

  // Combine cookies for JWT request
  const cookieHeader = cookies.map((cookie) => cookie.split(';')[0].trim()).join('; ');

  // Get JWT token
  const jwtResponse = await fetch(`${BETTER_AUTH_URL}/token`, {
    method: 'GET',
    headers: {
      Cookie: cookieHeader,
    },
    credentials: 'include',
  });

  if (!jwtResponse.ok) {
    const errorText = await jwtResponse.text();
    throw new Error(`Admin JWT token request failed: ${jwtResponse.status} ${errorText}`);
  }

  const jwtData = await jwtResponse.json();

  if (!jwtData?.token) {
    throw new Error('No token in admin JWT response');
  }

  return jwtData.token;
}

module.exports = {
  signInAnonymous,
  getAnonymousToken,
  banUser,
  unbanUser,
  getAdminToken,
  BETTER_AUTH_URL,
};
