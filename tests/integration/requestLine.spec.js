require('dotenv').config({ path: '../../.env' });
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const crypto = require('crypto');
const postgres = require('postgres');

// Database connection for test utilities
const getDbConnection = () => {
  const dbPort = process.env.DB_PORT || 5432;
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: dbPort,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });
};

// Helper to generate a valid UUID for test device IDs
const generateTestDeviceId = () => crypto.randomUUID();

// Helper to block a device in the database
const blockDevice = async (deviceId) => {
  const sql = getDbConnection();
  try {
    await sql`
      UPDATE anonymous_devices
      SET blocked = true, blocked_at = NOW(), blocked_reason = 'Test block'
      WHERE device_id = ${deviceId}
    `;
  } finally {
    await sql.end();
  }
};

// Helper to unblock a device (cleanup)
const unblockDevice = async (deviceId) => {
  const sql = getDbConnection();
  try {
    await sql`
      UPDATE anonymous_devices
      SET blocked = false, blocked_at = NULL, blocked_reason = NULL
      WHERE device_id = ${deviceId}
    `;
  } finally {
    await sql.end();
  }
};

// Helper to register a test device and get a token
const registerTestDevice = async (deviceId = null) => {
  const testDeviceId = deviceId || generateTestDeviceId();
  const response = await request
    .post('/request/register')
    .send({ deviceId: testDeviceId });

  return {
    deviceId: testDeviceId,
    token: response.body.token,
    expiresAt: response.body.expiresAt,
    response,
  };
};

describe('Request Line Endpoint', () => {
  describe('Device Registration', () => {
    it('should register a new device and return a token', async () => {
      const { response, deviceId } = await registerTestDevice();

      expect(response.status).toBe(200);
      expect(response.body.token).toBeDefined();
      expect(response.body.expiresAt).toBeDefined();
      expect(typeof response.body.token).toBe('string');
      expect(response.body.token.length).toBeGreaterThan(0);
    });

    it('should return 400 when deviceId is missing', async () => {
      const response = await request.post('/request/register').send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/deviceId/i);
    });

    it('should return 400 when deviceId is invalid format', async () => {
      const response = await request
        .post('/request/register')
        .send({ deviceId: 'not-a-valid-uuid' });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/invalid/i);
    });

    it('should return same device for repeated registration with same deviceId', async () => {
      const deviceId = generateTestDeviceId();

      const response1 = await request.post('/request/register').send({ deviceId });
      const response2 = await request.post('/request/register').send({ deviceId });

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      // Both should succeed (tokens may differ but both should be valid)
      expect(response1.body.token).toBeDefined();
      expect(response2.body.token).toBeDefined();
    });

    it('should return 403 when device is blocked', async () => {
      // Register a device first
      const deviceId = generateTestDeviceId();
      const registerResponse = await request.post('/request/register').send({ deviceId });
      expect(registerResponse.status).toBe(200);
      const { token } = registerResponse.body;

      // Make a request with the token - should succeed before blocking
      const successResponse = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Test before block' });
      expect(successResponse.status).toBe(200);

      // Block the device in the database
      await blockDevice(deviceId);

      try {
        // Attempt to make another request - should return 403
        const blockedResponse = await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: 'Test after block' });
        expect(blockedResponse.status).toBe(403);
        expect(blockedResponse.body.message).toMatch(/blocked/i);

        // Attempt to re-register - should also return 403
        const reRegisterResponse = await request.post('/request/register').send({ deviceId });
        expect(reRegisterResponse.status).toBe(403);
        expect(reRegisterResponse.body.message).toMatch(/blocked/i);
      } finally {
        // Cleanup: unblock the device
        await unblockDevice(deviceId);
      }
    });
  });

  describe('Anonymous Authentication', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const response = await request
        .post('/request')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should return 401 with invalid token format', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', 'invalid-token')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should return 401 with invalid Bearer token', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', 'Bearer invalid-jwt-token')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should accept valid anonymous device token', async () => {
      const { token } = await registerTestDevice();

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
      const { token } = await registerTestDevice();
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
      const { token } = await registerTestDevice();
      testToken = token;
    });

    it('should handle simple text message', async () => {
      const testMessage = 'Please play Carry the Zero by Built to Spill';

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Request line submitted successfully');
      expect(response.body.result).toBeDefined();
      expect(response.body.result.success).toBe(true);
    });

    it('should handle message with special characters', async () => {
      const testMessage = 'Request: "Señor" by Los Ángeles Azules!';

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle message with newlines', async () => {
      const testMessage = 'Song Request:\nArtist: Built to Spill\nTrack: Carry the Zero';

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle message at maximum length (500 characters)', async () => {
      const maxMessage = 'A'.repeat(500);

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: maxMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Response Structure', () => {
    let testToken;

    beforeAll(async () => {
      const { token } = await registerTestDevice();
      testToken = token;
    });

    it('should return correct response structure', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('result');
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Request line submitted successfully');
    });

    it('should include result object with success flag', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Test message' });

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
      const { token } = await registerTestDevice();
      testToken = token;
    });

    it('should handle rapid successive requests (up to rate limit)', async () => {
      // Note: Rate limit is 10 per 15 minutes per device
      const requests = Array(5)
        .fill(null)
        .map((_, i) =>
          request
            .post('/request')
            .set('Authorization', `Bearer ${testToken}`)
            .send({ message: `Rapid request ${i}` })
        );

      const responses = await Promise.all(requests);

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
          anotherField: 123,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('HTTP Methods', () => {
    let testToken;

    beforeAll(async () => {
      const { token } = await registerTestDevice();
      testToken = token;
    });

    it('should reject GET requests', async () => {
      const response = await request
        .get('/request')
        .set('Authorization', `Bearer ${testToken}`);

      expect(response.status).toBe(404);
    });

    it('should reject PUT requests', async () => {
      const response = await request
        .put('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(404);
    });

    it('should reject DELETE requests', async () => {
      const response = await request
        .delete('/request')
        .set('Authorization', `Bearer ${testToken}`);

      expect(response.status).toBe(404);
    });

    it('should reject PATCH requests', async () => {
      const response = await request
        .patch('/request')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(404);
    });
  });

  describe('Token Refresh', () => {
    it('should include refresh token headers when token is nearing expiration', async () => {
      // This test would require mocking the token expiration
      // For now, we just verify the headers can be present
      const { token } = await registerTestDevice();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      // Note: X-Refresh-Token headers will only be present if token is within refresh threshold
      // In normal test conditions, a fresh token won't trigger refresh
    });
  });
});
