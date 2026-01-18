require('dotenv').config({ path: '../../.env' });
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

describe('Song Request Endpoint', () => {
  describe('Authentication', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const response = await request
        .post('/request')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', 'invalid-token')
        .send({ message: 'Test song request' });

      expect(response.status).toBe(401);
    });

    it('should accept valid authentication token', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: 'Test song request' });

      expect(response.status).toBe(200);
    });
  });

  describe('Input Validation', () => {
    it('should return 400 when message field is missing', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({});

      expect(response.status).toBe(400);
      expect(response.text).toBe('Bad Request: Missing song request message');
    });

    it('should return 400 when request body is empty', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send();

      expect(response.status).toBe(400);
    });

    it('should accept empty string message', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: '' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Message Content', () => {
    it('should handle simple text message', async () => {
      const testMessage = 'Please play Carry the Zero by Built to Spill';

      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Song request submitted successfully');
      expect(response.body.result).toBeDefined();
      expect(response.body.result.success).toBe(true);
    });

    it('should handle message with special characters', async () => {
      const testMessage = 'Request: "Señor" by Los Ángeles Azules!';

      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle message with newlines', async () => {
      const testMessage = 'Song Request:\nArtist: Built to Spill\nTrack: Carry the Zero';

      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle long messages (1000 characters)', async () => {
      const longMessage = 'A'.repeat(1000);

      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: longMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should handle message with only whitespace', async () => {
      const testMessage = '   \t\n   ';

      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: testMessage });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Response Structure', () => {
    it('should return correct response structure', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('result');
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Song request submitted successfully');
    });

    it('should include result object with success flag', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.body.result).toBeDefined();
      expect(response.body.result.success).toBe(true);
    });

    it('should return proper content-type header', async () => {
      const response = await request
        .post('/request')
        .set('Authorization', global.access_token)
        .send({ message: 'Test message' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid successive requests', async () => {
      const requests = Array(5)
        .fill(null)
        .map((_, i) =>
          request
            .post('/request')
            .set('Authorization', global.access_token)
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
        .set('Authorization', global.access_token)
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
    it('should reject GET requests', async () => {
      const response = await request
        .get('/request')
        .set('Authorization', global.access_token);

      expect(response.status).toBe(404);
    });

    it('should reject PUT requests', async () => {
      const response = await request
        .put('/request')
        .set('Authorization', global.access_token)
        .send({ message: 'Test message' });

      expect(response.status).toBe(404);
    });

    it('should reject DELETE requests', async () => {
      const response = await request
        .delete('/request')
        .set('Authorization', global.access_token);

      expect(response.status).toBe(404);
    });

    it('should reject PATCH requests', async () => {
      const response = await request
        .patch('/request')
        .set('Authorization', global.access_token)
        .send({ message: 'Test message' });

      expect(response.status).toBe(404);
    });
  });
});
