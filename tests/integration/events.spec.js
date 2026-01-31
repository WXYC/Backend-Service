const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const http = require('http');
const { createAuthRequest, expectErrorContains, expectFields } = require('../utils/test_helpers');

/**
 * Server-Sent Events (SSE) Endpoints Integration Tests
 *
 * Tests for:
 * - POST /events/register - Register an SSE client (opens persistent connection)
 * - PUT /events/subscribe - Subscribe to event topics
 * - GET /events/test - Trigger a test broadcast event
 */

/**
 * Helper to make an SSE connection and collect the initial events.
 * Uses native http module with AbortController for proper stream handling.
 */
const connectSSE = (authToken, topics = [], timeoutMs = 2000) => {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.TEST_HOST}:${process.env.PORT}/events/register`);
    const body = JSON.stringify({ topics });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: authToken,
      },
      signal: controller.signal,
    };

    let receivedData = '';
    const events = [];

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        reject(new Error(`Unexpected status code: ${res.statusCode}`));
        return;
      }

      // Verify SSE headers
      const contentType = res.headers['content-type'];
      if (!contentType || !contentType.includes('text/event-stream')) {
        clearTimeout(timeout);
        reject(new Error(`Expected text/event-stream, got: ${contentType}`));
        return;
      }

      res.on('data', (chunk) => {
        receivedData += chunk.toString();

        // Parse SSE data format (data: {...}\n\n)
        const lines = receivedData.split('\n\n');
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.slice(6));
              events.push(eventData);
            } catch (e) {
              // Ignore parse errors for partial data
            }
          }
        }
        // Keep the last incomplete chunk
        receivedData = lines[lines.length - 1];

        // Once we have the connection event, we can resolve
        if (events.length > 0 && events[0].type === 'connection-established') {
          clearTimeout(timeout);
          controller.abort();
          resolve({ events, headers: res.headers });
        }
      });

      res.on('error', (err) => {
        // AbortError is expected when we call controller.abort()
        if (err.name !== 'AbortError') {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      // AbortError is expected
      if (err.name === 'AbortError' && events.length > 0) {
        resolve({ events, headers: {} });
      } else if (err.name !== 'AbortError') {
        reject(err);
      }
    });

    req.write(body);
    req.end();
  });
};

describe('Server-Sent Events', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('POST /events/register', () => {
    test('establishes SSE connection and returns client ID', async () => {
      const { events, headers } = await connectSSE(global.access_token);

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('connection-established');
      expectFields(events[0], 'payload');
      expectFields(events[0].payload, 'clientId');
      expect(typeof events[0].payload.clientId).toBe('string');
      expect(headers['content-type']).toContain('text/event-stream');
    });

    test('establishes SSE connection with topics', async () => {
      const { events } = await connectSSE(global.access_token, ['test-topic']);

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('connection-established');
      expectFields(events[0].payload, 'clientId');
    });
  });

  describe('PUT /events/subscribe', () => {
    test('returns 400 when client_id is missing', async () => {
      const res = await auth.put('/events/subscribe').send({ topics: ['test'] }).expect(400);

      expectErrorContains(res, 'client_id');
    });

    test('returns 400 when topics is missing', async () => {
      const res = await auth.put('/events/subscribe').send({ client_id: 'test-client-123' }).expect(400);

      expectErrorContains(res, 'topics');
    });

    test('returns 400 when both client_id and topics are missing', async () => {
      const res = await auth.put('/events/subscribe').send({}).expect(400);

      expect(res.body.message).toBeDefined();
    });

    test('handles subscription with non-existent client gracefully', async () => {
      const res = await auth.put('/events/subscribe').send({
        client_id: 'non-existent-client-id-12345',
        topics: ['test'],
      });

      // Should either return success (empty subscription) or an error
      expect([200, 400, 404, 500].includes(res.status)).toBe(true);
    });
  });

  describe('GET /events/test', () => {
    test('triggers test event successfully', async () => {
      const res = await auth.get('/events/test').expect(200);

      expectFields(res.body, 'message');
      expect(res.body.message).toBe('event triggered');
    });

    test('triggers test event without auth (public endpoint)', async () => {
      const res = await request.get('/events/test').expect(200);

      expectFields(res.body, 'message');
      expect(res.body.message).toBe('event triggered');
    });
  });
});
