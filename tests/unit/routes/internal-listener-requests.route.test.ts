/**
 * Unit tests for POST/GET /internal/listener-requests (BS#2662).
 *
 * Same gate and mock shape as internal-bans.route.test.ts: X-Internal-Key
 * matched against ROM_INTERNAL_KEY, one shared mockChain whose terminal
 * methods are overridden per test with mockResolvedValueOnce.
 */

import { db } from '@wxyc/database';
import express from 'express';
import request from 'supertest';

process.env.ROM_INTERNAL_KEY = 'test-rom-secret-key';

import { internalListenerRequestsRoute } from '../../../apps/backend/routes/internal-listener-requests.route';

const mockDb = db as unknown as Record<string, jest.Mock>;
const mockChain = mockDb.select();
const mockLimit = jest.fn();
(mockChain as Record<string, jest.Mock>).limit = mockLimit;
const mockReturning = jest.fn();
(mockChain as Record<string, jest.Mock>).returning = mockReturning;

const app = express();
app.use(express.json());
app.use('/internal/listener-requests', internalListenerRequestsRoute);

const URL = '/internal/listener-requests';
const KEY = 'test-rom-secret-key';
const FP = '11111111-1111-1111-1111-111111111111';
const REQUEST_ID = '22222222-2222-2222-2222-222222222222';
const EXPIRES_AT = new Date('2026-10-26T12:30:00Z');

const created = { id: REQUEST_ID, expires_at: EXPIRES_AT };

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks() does NOT drain mockResolvedValueOnce queues.
  mockLimit.mockReset();
  mockReturning.mockReset();
  delete process.env.LISTENER_REPLY_WINDOW_MINUTES;
});

describe('POST /internal/listener-requests', () => {
  const valid = { fingerprint: FP, slack_channel_id: 'C123' };

  it('returns 401 without X-Internal-Key', async () => {
    const res = await request(app).post(URL).send(valid);
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong key', async () => {
    const res = await request(app).post(URL).set('X-Internal-Key', 'wrong').send(valid);
    expect(res.status).toBe(401);
  });

  it.each([
    ['fingerprint is not a UUID', { ...valid, fingerprint: 'not-a-uuid' }, /fingerprint/i],
    ['fingerprint is missing', { slack_channel_id: 'C123' }, /fingerprint/i],
    ['slack_channel_id is missing', { fingerprint: FP }, /slack_channel_id/i],
    ['slack_channel_id is not a string', { ...valid, slack_channel_id: 7 }, /slack_channel_id/i],
    ['slack_channel_id is empty', { ...valid, slack_channel_id: '' }, /slack_channel_id/i],
    ['slack_channel_id exceeds 64 characters', { ...valid, slack_channel_id: 'C'.repeat(65) }, /slack_channel_id/i],
    ['anonymous_user_id is not a string', { ...valid, anonymous_user_id: 42 }, /anonymous_user_id/i],
    ['anonymous_user_id is empty', { ...valid, anonymous_user_id: '' }, /anonymous_user_id/i],
    [
      'anonymous_user_id exceeds 255 characters',
      { ...valid, anonymous_user_id: 'u'.repeat(256) },
      /anonymous_user_id/i,
    ],
  ])('returns 400 when %s', async (_label, body, message) => {
    const res = await request(app).post(URL).set('X-Internal-Key', KEY).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(mockReturning).not.toHaveBeenCalled();
  });

  it('returns 201 with replyable=false when anonymous_user_id is omitted', async () => {
    mockReturning.mockResolvedValueOnce([created]);
    const res = await request(app).post(URL).set('X-Internal-Key', KEY).send(valid);
    expect(res.status).toBe(201);
    expect(res.body.replyable).toBe(false);
  });

  it('returns replyable=false when anonymous_user_id is null', async () => {
    mockReturning.mockResolvedValueOnce([created]);
    const res = await request(app)
      .post(URL)
      .set('X-Internal-Key', KEY)
      .send({ ...valid, anonymous_user_id: null });
    expect(res.status).toBe(201);
    expect(res.body.replyable).toBe(false);
  });

  it('returns 201 with replyable=true when anonymous_user_id is present', async () => {
    mockReturning.mockResolvedValueOnce([created]);
    const res = await request(app)
      .post(URL)
      .set('X-Internal-Key', KEY)
      .send({ ...valid, anonymous_user_id: 'u_abc' });
    expect(res.status).toBe(201);
    expect(res.body.replyable).toBe(true);
  });

  it('returns exactly id, expires_at and replyable', async () => {
    mockReturning.mockResolvedValueOnce([created]);
    const res = await request(app).post(URL).set('X-Internal-Key', KEY).send(valid);
    expect(Object.keys(res.body).sort()).toEqual(['expires_at', 'id', 'replyable']);
    expect(res.body.id).toBe(REQUEST_ID);
    expect(res.body.expires_at).toBe(EXPIRES_AT.toISOString());
  });

  it('stamps expires_at from LISTENER_REPLY_WINDOW_MINUTES, defaulting to 30', async () => {
    const insertValues = (mockChain as Record<string, jest.Mock>).values;
    mockReturning.mockResolvedValue([created]);
    const before = Date.now();
    await request(app).post(URL).set('X-Internal-Key', KEY).send(valid);
    const defaultStamp = (insertValues.mock.calls.at(-1)![0].expires_at as Date).getTime();
    expect(defaultStamp - before).toBeGreaterThanOrEqual(30 * 60_000);
    expect(defaultStamp - before).toBeLessThan(30 * 60_000 + 5_000);

    process.env.LISTENER_REPLY_WINDOW_MINUTES = '5';
    const beforeOverride = Date.now();
    await request(app).post(URL).set('X-Internal-Key', KEY).send(valid);
    const overrideStamp = (insertValues.mock.calls.at(-1)![0].expires_at as Date).getTime();
    expect(overrideStamp - beforeOverride).toBeGreaterThanOrEqual(5 * 60_000);
    expect(overrideStamp - beforeOverride).toBeLessThan(5 * 60_000 + 5_000);
  });

  it('returns 500 and writes nothing when LISTENER_REPLY_WINDOW_MINUTES is invalid', async () => {
    process.env.LISTENER_REPLY_WINDOW_MINUTES = 'soon';
    const res = await request(app).post(URL).set('X-Internal-Key', KEY).send(valid);
    expect(res.status).toBe(500);
    expect(mockReturning).not.toHaveBeenCalled();
  });

  it.each([
    [
      'drizzle-wrapped',
      Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('violates foreign key constraint'), { code: '23503' }),
      }),
    ],
    ['bare driver error', Object.assign(new Error('violates foreign key constraint'), { code: '23503' })],
  ])('returns 400, not 500, on a foreign-key violation for anonymous_user_id — %s', async (_label, fkError) => {
    mockReturning.mockRejectedValueOnce(fkError);
    const res = await request(app)
      .post(URL)
      .set('X-Internal-Key', KEY)
      .send({ ...valid, anonymous_user_id: 'u_does_not_exist' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/anonymous_user_id/i);
  });

  it('returns 500 on any other database error', async () => {
    mockReturning.mockRejectedValueOnce(new Error('connection reset'));
    const res = await request(app).post(URL).set('X-Internal-Key', KEY).send(valid);
    expect(res.status).toBe(500);
  });
});

describe('GET /internal/listener-requests', () => {
  const row = {
    id: REQUEST_ID,
    slack_ts: '1761480000.000100',
    created_at: new Date('2026-10-26T12:00:00Z'),
    expires_at: EXPIRES_AT,
    status: 'posted',
  };

  it('returns 401 without X-Internal-Key', async () => {
    const res = await request(app).get(`${URL}?slack_channel_id=C123&replyable_for=on_air`);
    expect(res.status).toBe(401);
  });

  it.each([
    ['slack_channel_id is absent', '?replyable_for=on_air', /slack_channel_id/i],
    [
      'slack_channel_id is repeated',
      '?slack_channel_id=C1&slack_channel_id=C2&replyable_for=on_air',
      /slack_channel_id/i,
    ],
    ['replyable_for is absent', '?slack_channel_id=C123', /replyable_for/i],
    ['replyable_for is not on_air or moderator', '?slack_channel_id=C123&replyable_for=nobody', /replyable_for/i],
  ])('returns 400 when %s', async (_label, query, message) => {
    const res = await request(app).get(`${URL}${query}`).set('X-Internal-Key', KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it.each(['on_air', 'moderator'])('returns 200 with items for replyable_for=%s', async (replyableFor) => {
    mockLimit.mockResolvedValueOnce([row]);
    const res = await request(app)
      .get(`${URL}?slack_channel_id=C123&replyable_for=${replyableFor}`)
      .set('X-Internal-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([JSON.parse(JSON.stringify(row))]);
    expect(Object.keys(res.body)).toEqual(['items']);
  });

  it('caps the query at 20 rows with no limit parameter', async () => {
    mockLimit.mockResolvedValueOnce([]);
    const res = await request(app)
      .get(`${URL}?slack_channel_id=C123&replyable_for=on_air&limit=500`)
      .set('X-Internal-Key', KEY);
    expect(res.status).toBe(200);
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('returns 500 on a database error', async () => {
    mockLimit.mockRejectedValueOnce(new Error('connection reset'));
    const res = await request(app).get(`${URL}?slack_channel_id=C123&replyable_for=on_air`).set('X-Internal-Key', KEY);
    expect(res.status).toBe(500);
  });
});
