require('dotenv').config({ path: '../../.env' });
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

// Mock DPoP token for testing
const createMockDPoPToken = () => {
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'test-x-coordinate',
      y: 'test-y-coordinate'
    }
  };
  
  const payload = {
    htu: `${process.env.TEST_HOST}:${process.env.PORT}/request`,
    htm: 'POST',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: 'test-jti-' + Date.now()
  };
  
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  
  return `${headerB64}.${payloadB64}.mock-signature`;
};

describe('Request Route', () => {
  describe('POST /request', () => {
    it('should return 401 when DPoP header is missing', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .send({ message: 'Please play Big Shot by Patrick Cowley' });

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('DPoP validation failed');
    });

    it('should return 400 when message is missing', async () => {
      const mockDPoP = createMockDPoPToken();
      
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .set('DPoP', mockDPoP)
        .send({});

      expect(response.status).toBe(400);
      expect(response.text).toBe('Bad Request: Missing song request message');
    });

    it('should return 200 when message is provided with valid DPoP', async () => {
      const mockDPoP = createMockDPoPToken();
      
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .set('DPoP', mockDPoP)
        .send({ message: 'Please play Big Shot by Patrick Cowley' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Song request submitted successfully');
      expect(response.body.result).toBeDefined();
    });

    it('should return 401 when DPoP token has expired', async () => {
      const header = {
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: {
          kty: 'EC',
          crv: 'P-256',
          x: 'test-x-coordinate',
          y: 'test-y-coordinate'
        }
      };
      
      const payload = {
        htu: `${process.env.TEST_HOST}:${process.env.PORT}/request`,
        htm: 'POST',
        iat: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
        exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago (expired)
        jti: 'test-jti-expired'
      };
      
      const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const expiredDPoP = `${headerB64}.${payloadB64}.mock-signature`;
      
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .set('DPoP', expiredDPoP)
        .send({ message: 'Please play Big Shot by Patrick Cowley' });

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('DPoP validation failed');
    });
  });
});
