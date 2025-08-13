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
      const testMessage = 'Please play Big Shot by Patrick Cowley';
      
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .set('DPoP', mockDPoP)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Song request submitted successfully');
      expect(response.body.result).toBeDefined();
      
      // Validate mock service response structure
      expect(response.body.result.success).toBe(true);
      expect(response.body.result.mock).toBe(true);
      expect(response.body.result.originalMessage).toBe(testMessage);
      expect(response.body.result.timestamp).toBeDefined();
      expect(new Date(response.body.result.timestamp)).toBeInstanceOf(Date);
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

    it('should handle empty message gracefully', async () => {
      const mockDPoP = createMockDPoPToken();
      
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .set('DPoP', mockDPoP)
        .send({ message: '' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.result.originalMessage).toBe('');
    });

    it('should handle very long messages', async () => {
      const mockDPoP = createMockDPoPToken();
      const longMessage = 'A'.repeat(1000); // 1000 character message
      
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .set('DPoP', mockDPoP)
        .send({ message: longMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.result.originalMessage).toBe(longMessage);
    });

    it('should validate request ID generation and logging', async () => {
      const mockDPoP = createMockDPoPToken();
      const testMessage = 'Test message for logging validation';
      
      // Capture console.log output to validate logging
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      const response = await request
        .post('/request')
        .set('Authorization', `Bearer ${global.access_token}`)
        .set('DPoP', mockDPoP)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      
      // Verify that logging occurred
      expect(consoleSpy).toHaveBeenCalled();
      
      // Find the completion log entry
      const completionLog = consoleSpy.mock.calls.find(call => 
        call[0].includes('Request completed successfully')
      );
      
      expect(completionLog).toBeDefined();
      expect(completionLog[0]).toContain('statusCode: 200');
      expect(completionLog[0]).toContain('responseTime:');
      
      consoleSpy.mockRestore();
    });
  });
});
