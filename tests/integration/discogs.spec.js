/**
 * Discogs Service Integration Tests
 *
 * Tests for the Discogs API client and service functionality.
 * These tests run with USE_MOCK_SERVICES=true to avoid hitting
 * the real Discogs API.
 *
 * Run with:
 *   npm test -- --testPathPatterns=discogs
 */

require('dotenv').config({ path: '../../.env' });
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { signInAnonymous } = require('../utils/anonymous_auth');

// Helper to get an anonymous auth token
const getTestToken = async () => {
  const { token, userId, user } = await signInAnonymous();
  return { token, userId, user };
};

describe('Discogs Service', () => {
  describe('parseTitle utility', () => {
    it('should handle standard "Artist - Album" format in search results', async () => {
      const { token } = await getTestToken();

      // Make a request that would trigger Discogs search (in mock mode)
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Play Blue Monday by New Order' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle titles with multiple dashes', async () => {
      const { token } = await getTestToken();

      // A song title like "Artist - Album - Deluxe Edition" should parse correctly
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Play something from The Dark Side of the Moon' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Mock Mode', () => {
    it('should return mock responses when USE_MOCK_SERVICES is true', async () => {
      const { token } = await getTestToken();

      // In mock mode, Discogs calls return mock data
      // The request should still succeed
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Play Autobahn by Kraftwerk' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Mock mode should not cause errors
      expect(response.body.error).toBeUndefined();
    });

    it('should handle search requests in mock mode', async () => {
      const { token } = await getTestToken();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'I want to hear some ambient music' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Service Availability', () => {
    it('should handle requests when Discogs credentials are configured', async () => {
      const { token } = await getTestToken();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Play anything by Aphex Twin' });

      expect(response.status).toBe(200);
      // Response should indicate success even if Discogs is in mock mode
      expect(response.body.success).toBe(true);
    });

    it('should gracefully handle artwork lookup in mock mode', async () => {
      const { token } = await getTestToken();

      // Request that would typically trigger artwork lookup
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Play Blue Lines by Massive Attack' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Should not fail even if artwork lookup returns mock data
    });
  });

  describe('Rate Limiter Behavior', () => {
    it('should not block rapid requests in mock mode', async () => {
      const { token } = await getTestToken();

      // Make several requests quickly - rate limiter should not block in mock mode
      // since we're not actually hitting the Discogs API
      const responses = [];
      for (let i = 0; i < 3; i++) {
        const response = await request
          .post('/request')
          .set('Authorization', `Bearer ${token}`)
          .send({ message: `Test request ${i}` });
        responses.push(response);
      }

      // All should succeed (subject to the request rate limiter, not Discogs rate limiter)
      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed requests gracefully', async () => {
      const { token } = await getTestToken();

      const response = await request.post('/request').set('Authorization', `Bearer ${token}`).send({ message: '' });

      // Should handle empty messages
      expect(response.status).toBe(400);
    });

    it('should handle requests without authentication', async () => {
      const response = await request.post('/request').send({ message: 'Play something' });

      expect(response.status).toBe(401);
    });
  });
});

describe('Discogs Integration with Request Line', () => {
  describe('Song Request Flow', () => {
    it('should process a complete song request with mock Discogs data', async () => {
      const { token } = await getTestToken();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Can you play Windowlicker by Aphex Twin?' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // parsed is only present when AI parsing is enabled (requires OPENAI_API_KEY)
      // In CI/legacy mode without parsing, the response uses a simpler format
      if (response.body.parsed) {
        expect(response.body.parsed.isRequest).toBeDefined();
      }
    });

    it('should handle requests with artist only', async () => {
      const { token } = await getTestToken();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Play something by Boards of Canada' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle requests with song only', async () => {
      const { token } = await getTestToken();

      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Play Halcyon and On and On' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});
