/**
 * Better-Auth test utility
 * Authenticates with better-auth service and retrieves JWT token for testing
 */

async function signIn() {
  const authUrl = process.env.BETTER_AUTH_URL || 'http://localhost:8082/api/auth';
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (!username || !password) {
    throw new Error('AUTH_USERNAME and AUTH_PASSWORD environment variables must be set');
  }

  try {
    // Sign in with username/password
    // Better-auth supports both /sign-in/username and /sign-in/email
    const signInResponse = await fetch(`${authUrl}/sign-in/username`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // Important: include cookies
      body: JSON.stringify({
        username: username,
        password: password,
      }),
    });

    if (!signInResponse.ok) {
      const errorText = await signInResponse.text();
      throw new Error(`Sign-in failed: ${signInResponse.status} ${errorText}`);
    }

    // Extract session cookies from response
    // In Node.js fetch, use getSetCookie() which returns an array of cookie strings
    const cookies = signInResponse.headers.getSetCookie();
    
    if (!cookies || cookies.length === 0) {
      throw new Error('No session cookie received from sign-in');
    }

    // Combine all cookies into a single Cookie header
    // Extract just the cookie name=value part (before any attributes like ; Path=, ; HttpOnly, etc.)
    const cookieHeader = cookies
      .map(cookie => cookie.split(';')[0].trim())
      .join('; ');

    // Get JWT token using the session cookie
    const jwtResponse = await fetch(`${authUrl}/token`, {
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
      },
      credentials: 'include',
    });

    if (!jwtResponse.ok) {
      const errorText = await jwtResponse.text();
      throw new Error(`JWT token request failed: ${jwtResponse.status} ${errorText}`);
    }

    const jwtData = await jwtResponse.json();
    
    if (!jwtData || !jwtData.token) {
      throw new Error('No token in JWT response');
    }

    return jwtData.token;
  } catch (error) {
    console.error(`Error connecting to better-auth service at ${authUrl}:`, error.message);
    throw error;
  }
}

async function get_access_token() {
  try {
    const token = await signIn();
    return token;
  } catch (error) {
    console.error('Failed to get access token from better-auth:', error.message);
    throw error;
  }
}

module.exports = get_access_token;

