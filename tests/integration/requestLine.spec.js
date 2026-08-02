require('dotenv').config({ path: '../../.env' });
const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous, unbanUser, BETTER_AUTH_URL } = require('../utils/anonymous_auth');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Helper to get a new anonymous auth token
const getTestToken = async () => {
  const { token, userId, user } = await signInAnonymous();
  return { token, userId, user };
};

describe('Request Line Endpoint', () => {
  describe('Device Registration (Legacy Endpoint)', () => {
    it('should return 410 Gone for legacy registration endpoint', async () => {
      const response = await request.post('/request/register').send({ deviceId: 'test-uuid' });

      expect(response.status).toBe(410);
      expect(response.body.message).toMatch(/deprecated/i);
      expect(response.body.endpoint).toMatch(/sign-in\/anonymous/);
    });
  });

  describe('JWT Authentication', () => {
    it('should return 401 without Authorization header', async () => {
      const response = await request.post('/request').send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should return 401 with malformed Authorization header', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', 'not-bearer-format')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should return 401 with empty Bearer token', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', 'Bearer ')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    // In AUTH_BYPASS mode, any well-formed Bearer token is accepted (bypass
    // skips JWKS signature verification). This test only validates in production.
    const describeIfNoBypass = process.env.AUTH_BYPASS === 'true' ? it.skip : it;
    describeIfNoBypass('should return 401 with invalid Bearer token', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', 'Bearer invalid-token')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should accept valid anonymous session token', async () => {
      const { token } = await getTestToken();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Test song request' });

      expect(response.status).toBe(200);
    });
  });

  describe('Input Validation', () => {
    let testToken;

    beforeAll(async () => {
      const { token } = await getTestToken();
      testToken = token;
    });

    it('should return 400 when message field is missing', async () => {
      const response = await request.post('/request').set('Authorization', `Bearer ${testToken}`).send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/missing/i);
    });

    it('should return 400 when request body is empty object', async () => {
      const response = await request.post('/request').set('Authorization', `Bearer ${testToken}`).send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/missing/i);
    });

    it('should return 400 for empty string message', async () => {
      const response = await request.post('/request').set('Authorization', `Bearer ${testToken}`).send({ message: '' });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/empty/i);
    });

    it('should return 400 for whitespace-only message', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: '   \t\n   ' });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/empty/i);
    });

    it('should return 400 when message exceeds 500 characters', async () => {
      const longMessage = 'A'.repeat(501);

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: longMessage });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/exceeds|maximum|length/i);
    });

    it('should accept message at exactly 500 characters', async () => {
      const maxMessage = 'A'.repeat(500);

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: maxMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Message Content', () => {
    let testToken;

    beforeAll(async () => {
      const { token } = await getTestToken();
      testToken = token;
    });

    it('should accept song request messages', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Play Blue Monday by New Order' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle special characters in message', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Play "Smells Like Teen Spirit" by Nirvana & friends!' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle unicode characters in message', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Play Mötley Crüe or 日本語 music' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle emoji in message', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Play some music 🎵🎸' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should trim leading and trailing whitespace', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: '   Test song request   ' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Response Structure', () => {
    let testToken;

    beforeAll(async () => {
      const { token } = await getTestToken();
      testToken = token;
    });

    it('should return JSON response with success field', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should include result object on success', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Test song request' });

      expect(response.status).toBe(200);
      expect(response.body.result).toBeDefined();
      expect(response.body.result.success).toBe(true);
    });

    it('should return proper content-type header', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Edge Cases', () => {
    let testToken;

    beforeAll(async () => {
      const { token } = await getTestToken();
      testToken = token;
    });

    it('should handle rapid successive requests (up to rate limit)', async () => {
      const promises = [];
      for (let i = 0; i < 3; i++) {
        promises.push(
          request
            .post('/request')
            .set('Authorization', `Bearer ${testToken}`)
            .send({ message: `Test request ${i}` })
        );
      }

      const responses = await Promise.all(promises);

      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });
    });

    it('should ignore extra fields in request body', async () => {
      const response = await request.post('/request').set('Authorization', `Bearer ${testToken}`).send({
        message: 'Test message',
        extraField: 'should be ignored',
        anotherExtra: 123,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('User Banning', () => {
    describe('with admin credentials', () => {
      // Gated the same way as check-request-ban.spec.js's admin-ban case
      // (BS#133 / BS#1941): cleanup below still needs the test_station_manager
      // admin fixture account via unbanUser(), so this test stays opt-in
      // rather than running by default in local dev.
      const enableAdminBan = process.env.TEST_ADMIN_BAN === 'true';
      const itIfAdminBan = enableAdminBan ? it : it.skip;

      // Flips auth_user.banned directly via SQL instead of better-auth's
      // /admin/ban-user endpoint (BS#1941). banUser() unconditionally calls
      // internalAdapter.deleteUserSessions(), which would kill the very
      // session this test needs alive to mint a JWT *after* the ban below —
      // the whole point of the fix is that AUTH_BYPASS only trusts the
      // `banned` claim baked into a JWT at mint time, so the JWT has to be
      // minted post-ban. Direct SQL is the existing project convention for
      // setup that would otherwise trip an HTTP side effect —
      // check-request-ban.spec.js's banned_fingerprints INSERT does the same
      // for its fingerprint case. Cleanup below still goes through the real
      // unbanUser() HTTP flow (no session side effect there), so this test
      // still needs the admin credentials TEST_ADMIN_BAN gates.
      async function banUserDirectly(sql, userId, reason) {
        await sql.unsafe(`UPDATE ${SCHEMA}.auth_user SET banned = true, ban_reason = $1 WHERE id = $2`, [
          reason,
          userId,
        ]);
      }

      // Exchanges a still-valid session token for a JWT via better-auth's
      // /token endpoint (the jwt() plugin) — mirrors
      // check-request-ban.spec.js's getAnonymousJwt(). Test-scoped: every
      // other test in this file keeps using getTestToken()'s raw session
      // token, which AUTH_BYPASS's catch-all also accepts but which
      // decodeJwt cannot parse into a `banned` claim (see BS#1941).
      async function mintJwt(sessionToken) {
        const jwtRes = await fetch(`${BETTER_AUTH_URL}/token`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${sessionToken}` },
        });
        if (!jwtRes.ok) {
          throw new Error(`Failed to fetch JWT: ${jwtRes.status} ${await jwtRes.text()}`);
        }
        const { token } = await jwtRes.json();
        return token;
      }

      itIfAdminBan('should return 403 when user is banned', async () => {
        // Get a new anonymous user
        const { token, userId } = await getTestToken();

        // Verify request works before banning
        const beforeBanResponse = await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: 'Test before ban' });
        expect(beforeBanResponse.status).toBe(200);

        const sql = postgres({
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
          database: process.env.DB_NAME || 'wxyc_db',
          user: process.env.DB_USERNAME || 'test-user',
          password: process.env.DB_PASSWORD || 'test-pw',
          onnotice: () => {},
          max: 1,
        });

        try {
          // Ban the user (direct SQL — see banUserDirectly above for why)
          await banUserDirectly(sql, userId, 'Test ban');

          // Mint a fresh JWT *after* the ban so its `banned` claim reflects
          // the current DB state — better-auth's cookieCache is off, so
          // /token always round-trips through the database (auth.definition.ts).
          const bannedJwt = await mintJwt(token);

          // Request should now return 403
          const afterBanResponse = await request
            .post('/request')
            .set('Authorization', `Bearer ${bannedJwt}`)
            .send({ message: 'Test after ban' });
          expect(afterBanResponse.status).toBe(403);
        } finally {
          // Clean up: unban the user (real admin HTTP flow) and close the
          // direct SQL client.
          await unbanUser(userId);
          await sql.end();
        }
      });
    });
  });
});
