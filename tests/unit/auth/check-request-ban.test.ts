/**
 * Unit tests for POST /auth/check-request-ban (BS#1261).
 *
 * The handler is called by request-o-matic on every POST /request to decide
 * whether to allow or block. Spec covers all 11 input/output combinations from
 * the issue's test acceptance section: JWT-only, fingerprint-only, both,
 * neither, invalid/expired JWT, user-not-found, banned-source precedence, and
 * the expired-ban-is-not-banned case.
 *
 * Mocks both better-auth's in-process verifyJWT (so we exercise the handler
 * without spinning up auth) and the Drizzle DB chain (so ban-state is
 * test-controllable per case).
 */

const mockVerifyJWT = jest.fn();

jest.mock('@wxyc/authentication', () => ({
  auth: {
    api: {
      verifyJWT: mockVerifyJWT,
    },
  },
}));

import { db } from '@wxyc/database';
import express from 'express';
import request from 'supertest';

import { checkRequestBanHandler } from '../../../apps/auth/check-request-ban-handler';

const mockDb = db as unknown as Record<string, jest.Mock>;
const mockChain = mockDb.select();
const mockLimit = jest.fn();
(mockChain as Record<string, jest.Mock>).limit = mockLimit;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/auth/check-request-ban', checkRequestBanHandler);
  return app;
}

const VALID_JWT = 'header.payload.signature';
const FINGERPRINT = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'user-abc-123';

describe('POST /auth/check-request-ban', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('neither signal provided', () => {
    it('returns 400 no_signal when neither JWT nor fingerprint is present', async () => {
      const res = await request(makeApp()).post('/auth/check-request-ban');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'no_signal' });
      expect(mockVerifyJWT).not.toHaveBeenCalled();
    });
  });

  describe('JWT-only path', () => {
    it('returns 401 invalid_token when verifyJWT returns null payload', async () => {
      mockVerifyJWT.mockResolvedValueOnce({ payload: null });

      const res = await request(makeApp()).post('/auth/check-request-ban').set('Authorization', `Bearer ${VALID_JWT}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_token' });
    });

    it('returns 401 invalid_token when Authorization header is malformed', async () => {
      const res = await request(makeApp()).post('/auth/check-request-ban').set('Authorization', 'not-a-bearer');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_token' });
    });

    it('returns 404 user_not_found when JWT verifies but no user row matches sub', async () => {
      mockVerifyJWT.mockResolvedValueOnce({ payload: { sub: USER_ID } });
      mockLimit.mockResolvedValueOnce([]);

      const res = await request(makeApp()).post('/auth/check-request-ban').set('Authorization', `Bearer ${VALID_JWT}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'user_not_found' });
    });

    it('returns 200 banned:false when user is not banned', async () => {
      mockVerifyJWT.mockResolvedValueOnce({ payload: { sub: USER_ID } });
      mockLimit.mockResolvedValueOnce([{ id: USER_ID, banned: false, banReason: null }]);

      const res = await request(makeApp()).post('/auth/check-request-ban').set('Authorization', `Bearer ${VALID_JWT}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: USER_ID, fingerprint: null, banned: false });
    });

    it('returns 200 banned:true with banSource:"user" when user.banned is true', async () => {
      mockVerifyJWT.mockResolvedValueOnce({ payload: { sub: USER_ID } });
      mockLimit.mockResolvedValueOnce([{ id: USER_ID, banned: true, banReason: 'spamming slurs' }]);

      const res = await request(makeApp()).post('/auth/check-request-ban').set('Authorization', `Bearer ${VALID_JWT}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId: USER_ID,
        fingerprint: null,
        banned: true,
        banReason: 'spamming slurs',
        banSource: 'user',
      });
    });
  });

  describe('fingerprint-only path', () => {
    it('returns 200 banned:false when fingerprint has no ban row', async () => {
      mockLimit.mockResolvedValueOnce([]); // banned_fingerprints lookup

      const res = await request(makeApp()).post('/auth/check-request-ban').set('X-Device-Fingerprint', FINGERPRINT);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: null, fingerprint: FINGERPRINT, banned: false });
      expect(mockVerifyJWT).not.toHaveBeenCalled();
    });

    it('returns 200 banned:true with banSource:"fingerprint" when fingerprint is banned', async () => {
      mockLimit.mockResolvedValueOnce([
        { fingerprint: FINGERPRINT, ban_reason: 'racist messages', ban_expires_at: null },
      ]);

      const res = await request(makeApp()).post('/auth/check-request-ban').set('X-Device-Fingerprint', FINGERPRINT);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId: null,
        fingerprint: FINGERPRINT,
        banned: true,
        banReason: 'racist messages',
        banSource: 'fingerprint',
      });
    });

    it('treats an expired ban row as not banned', async () => {
      // The DB query filters with `ban_expires_at IS NULL OR ban_expires_at > now()`,
      // so an expired row returns no result.
      mockLimit.mockResolvedValueOnce([]);

      const res = await request(makeApp()).post('/auth/check-request-ban').set('X-Device-Fingerprint', FINGERPRINT);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: null, fingerprint: FINGERPRINT, banned: false });
    });
  });

  describe('JWT + fingerprint together', () => {
    it('returns banSource:"fingerprint" when both user and fingerprint are banned', async () => {
      mockVerifyJWT.mockResolvedValueOnce({ payload: { sub: USER_ID } });
      // Order: user lookup → fingerprint lookup (or vice versa — the handler may
      // run them in parallel). Queue both so either ordering resolves.
      mockLimit
        .mockResolvedValueOnce([{ id: USER_ID, banned: true, banReason: 'user reason' }])
        .mockResolvedValueOnce([{ fingerprint: FINGERPRINT, ban_reason: 'fp reason', ban_expires_at: null }]);

      const res = await request(makeApp())
        .post('/auth/check-request-ban')
        .set('Authorization', `Bearer ${VALID_JWT}`)
        .set('X-Device-Fingerprint', FINGERPRINT);

      expect(res.status).toBe(200);
      expect(res.body.banned).toBe(true);
      expect(res.body.banSource).toBe('fingerprint');
      expect(res.body.banReason).toBe('fp reason');
      expect(res.body.userId).toBe(USER_ID);
      expect(res.body.fingerprint).toBe(FINGERPRINT);
    });

    it('returns banSource:"user" when only user is banned', async () => {
      mockVerifyJWT.mockResolvedValueOnce({ payload: { sub: USER_ID } });
      mockLimit
        .mockResolvedValueOnce([{ id: USER_ID, banned: true, banReason: 'just the user' }])
        .mockResolvedValueOnce([]);

      const res = await request(makeApp())
        .post('/auth/check-request-ban')
        .set('Authorization', `Bearer ${VALID_JWT}`)
        .set('X-Device-Fingerprint', FINGERPRINT);

      expect(res.status).toBe(200);
      expect(res.body.banned).toBe(true);
      expect(res.body.banSource).toBe('user');
    });

    it('returns banned:false when neither is banned', async () => {
      mockVerifyJWT.mockResolvedValueOnce({ payload: { sub: USER_ID } });
      mockLimit.mockResolvedValueOnce([{ id: USER_ID, banned: false, banReason: null }]).mockResolvedValueOnce([]);

      const res = await request(makeApp())
        .post('/auth/check-request-ban')
        .set('Authorization', `Bearer ${VALID_JWT}`)
        .set('X-Device-Fingerprint', FINGERPRINT);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: USER_ID, fingerprint: FINGERPRINT, banned: false });
    });
  });

  describe('fingerprint format', () => {
    it('returns 400 when fingerprint header is present but not a valid UUID', async () => {
      const res = await request(makeApp()).post('/auth/check-request-ban').set('X-Device-Fingerprint', 'not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_fingerprint' });
    });
  });
});
