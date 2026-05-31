/**
 * Unit tests for /internal/banned-fingerprints CRUD (BS#1261).
 *
 * Authenticates via X-Internal-Key (matched against ROM_INTERNAL_KEY env var,
 * mirroring the X-Internal-Key pattern in internal.route.ts but keyed on a
 * different env var per the spec — different caller, different blast radius).
 *
 * Mock pattern follows internal.route.test.ts: a single shared mockChain
 * whose terminal methods are overridable per test via mockResolvedValueOnce.
 */

import { db } from '@wxyc/database';
import express from 'express';
import request from 'supertest';

process.env.ROM_INTERNAL_KEY = 'test-rom-secret-key';

import { internalBansRoute } from '../../../apps/backend/routes/internal-bans.route';

const mockDb = db as unknown as Record<string, jest.Mock>;
const mockChain = mockDb.select();
const mockLimit = jest.fn();
(mockChain as Record<string, jest.Mock>).limit = mockLimit;
const mockReturning = jest.fn();
(mockChain as Record<string, jest.Mock>).returning = mockReturning;
const mockOffset = jest.fn();
(mockChain as Record<string, jest.Mock>).offset = mockOffset;

const app = express();
app.use(express.json());
app.use('/internal/banned-fingerprints', internalBansRoute);

const KEY = 'test-rom-secret-key';
const FP = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /internal/banned-fingerprints (create)', () => {
  it('returns 401 without X-Internal-Key header', async () => {
    const res = await request(app).post('/internal/banned-fingerprints').send({ fingerprint: FP, reason: 'spam' });
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong key', async () => {
    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', 'wrong')
      .send({ fingerprint: FP, reason: 'spam' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is missing fingerprint', async () => {
    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ reason: 'spam' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fingerprint/i);
  });

  it('returns 400 when body is missing reason', async () => {
    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ fingerprint: FP });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it('returns 400 when fingerprint is not a UUID', async () => {
    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ fingerprint: 'not-a-uuid', reason: 'spam' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when expiresInSeconds is a non-integer', async () => {
    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ fingerprint: FP, reason: 'spam', expiresInSeconds: 3600.5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/integer/i);
  });

  it('returns 400 when bannedByUserId is provided as a non-string', async () => {
    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ fingerprint: FP, reason: 'spam', bannedByUserId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bannedByUserId/i);
  });

  it('accepts an omitted bannedByUserId (defaults to null)', async () => {
    const row = {
      fingerprint: FP,
      banned_at: new Date('2026-05-31T12:00:00Z'),
      ban_reason: 'spam',
      ban_expires_at: null,
      banned_by_user_id: null,
    };
    mockReturning.mockResolvedValueOnce([row]);

    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ fingerprint: FP, reason: 'spam' });

    expect(res.status).toBe(200);
    expect(res.body.banned_by_user_id).toBeNull();
  });

  it('returns 200 with the created row on success', async () => {
    const row = {
      fingerprint: FP,
      banned_at: new Date('2026-05-31T12:00:00Z'),
      ban_reason: 'spam',
      ban_expires_at: null,
      banned_by_user_id: null,
    };
    mockReturning.mockResolvedValueOnce([row]);

    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ fingerprint: FP, reason: 'spam' });

    expect(res.status).toBe(200);
    expect(res.body.fingerprint).toBe(FP);
    expect(res.body.ban_reason).toBe('spam');
    expect(res.body.ban_expires_at).toBeNull();
  });

  it('honors expiresInSeconds by computing ban_expires_at', async () => {
    const row = {
      fingerprint: FP,
      banned_at: new Date('2026-05-31T12:00:00Z'),
      ban_reason: 'temp',
      ban_expires_at: new Date('2026-05-31T13:00:00Z'),
      banned_by_user_id: null,
    };
    mockReturning.mockResolvedValueOnce([row]);

    const res = await request(app)
      .post('/internal/banned-fingerprints')
      .set('X-Internal-Key', KEY)
      .send({ fingerprint: FP, reason: 'temp', expiresInSeconds: 3600 });

    expect(res.status).toBe(200);
    expect(res.body.ban_expires_at).toBe('2026-05-31T13:00:00.000Z');
  });
});

describe('DELETE /internal/banned-fingerprints/:fingerprint', () => {
  it('returns 401 without X-Internal-Key', async () => {
    const res = await request(app).delete(`/internal/banned-fingerprints/${FP}`);
    expect(res.status).toBe(401);
  });

  it('returns 204 on successful delete', async () => {
    mockReturning.mockResolvedValueOnce([{ fingerprint: FP }]);
    const res = await request(app).delete(`/internal/banned-fingerprints/${FP}`).set('X-Internal-Key', KEY);
    expect(res.status).toBe(204);
  });

  it('returns 204 even when row does not exist (idempotent)', async () => {
    mockReturning.mockResolvedValueOnce([]);
    const res = await request(app).delete(`/internal/banned-fingerprints/${FP}`).set('X-Internal-Key', KEY);
    expect(res.status).toBe(204);
  });

  it('returns 400 when path param is not a UUID', async () => {
    const res = await request(app).delete('/internal/banned-fingerprints/not-a-uuid').set('X-Internal-Key', KEY);
    expect(res.status).toBe(400);
  });
});

describe('GET /internal/banned-fingerprints (list)', () => {
  it('returns 401 without X-Internal-Key', async () => {
    const res = await request(app).get('/internal/banned-fingerprints');
    expect(res.status).toBe(401);
  });

  it('returns 200 with items + nextCursor:null when result fits in one page', async () => {
    mockLimit.mockResolvedValueOnce([
      {
        fingerprint: FP,
        banned_at: new Date('2026-05-31T12:00:00Z'),
        ban_reason: 'spam',
        ban_expires_at: null,
        banned_by_user_id: null,
      },
    ]);

    const res = await request(app).get('/internal/banned-fingerprints').set('X-Internal-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].fingerprint).toBe(FP);
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns nextCursor when result has exactly limit+1 rows', async () => {
    // Handler asks for limit+1 to detect a next page.
    const items = Array.from({ length: 3 }, (_, i) => ({
      fingerprint: `1111111${i}-1111-1111-1111-11111111111${i}`.slice(0, 36),
      banned_at: new Date('2026-05-31T12:00:00Z'),
      ban_reason: 'spam',
      ban_expires_at: null,
      banned_by_user_id: null,
    }));
    mockLimit.mockResolvedValueOnce(items);

    const res = await request(app).get('/internal/banned-fingerprints?limit=2').set('X-Internal-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).not.toBeNull();
  });
});
