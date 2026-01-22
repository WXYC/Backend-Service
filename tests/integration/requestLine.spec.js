require('dotenv').config({ path: '../../.env' });
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous, banUser, unbanUser, getAdminToken } = require('../utils/anonymous_auth');

// Helper to get a new anonymous auth token
const getTestToken = async () => {
  const { token, userId, user } = await signInAnonymous();
  return { token, userId, user };
};

describe('Request Line Endpoint', () => {
  describe('Device Registration (Legacy Endpoint)', () => {
    it('should return 301 redirect for legacy registration endpoint', async () => {
      const response = await request.post('/request/register').send({ deviceId: 'test-uuid' });

      expect(response.status).toBe(301);
      expect(response.body.message).toMatch(/deprecated/i);
      expect(response.body.endpoint).toMatch(/sign-in\/anonymous/);
    });
  });

  describe('Anonymous Authentication', () => {
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

    it('should return 401 with invalid Bearer token', async () => {
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
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/missing/i);
    });

    it('should return 400 when request body is empty object', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/missing/i);
    });

    it('should return 400 for empty string message', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: '' });

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
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          message: 'Test message',
          extraField: 'should be ignored',
          anotherExtra: 123,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('User Banning', () => {
    // Skip these tests if admin credentials aren't configured or TEST_ADMIN_BAN isn't explicitly enabled
    // Admin tests require valid credentials that exist in the auth database
    const enableAdminTests = process.env.TEST_ADMIN_BAN === 'true';
    const describeOrSkip = enableAdminTests ? describe : describe.skip;

    describeOrSkip('with admin credentials', () => {
      it('should return 403 when user is banned', async () => {
        // Get a new anonymous user
        const { token, userId } = await getTestToken();

        // Verify request works before banning
        const beforeBanResponse = await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: 'Test before ban' });
        expect(beforeBanResponse.status).toBe(200);

        // Ban the user
        await banUser(userId, 'Test ban');

        // Request should now return 403
        const afterBanResponse = await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: 'Test after ban' });
        expect(afterBanResponse.status).toBe(403);

        // Clean up: unban the user
        await unbanUser(userId);
      });
    });
  });
});
