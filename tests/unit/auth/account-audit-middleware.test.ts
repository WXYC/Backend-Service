/**
 * Unit tests for apps/auth/account-audit-middleware.ts (BS#2537, parent epic
 * #2534): the coverage-rule matrix (non-GET logged, GET skipped unless
 * included, OPTIONS/HEAD always skipped), the unknown-admin-path gate (M2),
 * actor + impersonator resolution, subject extraction (asserting the
 * submitted email never lands in the recorded event), error_code capture
 * for a better-auth-shaped string body, a Uint8Array chunk in the real
 * better-call shape, and an Express typed-error body, the public-mount 2xx
 * subject gate, the finish/close write-once guard, and the M1
 * close-without-finish guard.
 *
 * Admin-prefix requests below are built in the Express-real, mount-stripped
 * shape (`mockAdminReq`) rather than the un-stripped shape the original
 * suite used — that un-stripped shape is exactly what let the HIGH 1
 * mount-path-stripping bug (code review BS#2537 PR #2545) ship pinned by
 * fictions: every assertion passed against request shapes Express never
 * actually produces.
 */
import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

import { auth } from '../../mocks/authentication.mock';
import { db, recordAccountAuditEvent } from '../../mocks/database.mock';
import { adminPrefixAuditMiddleware, flatMountAuditMiddleware } from '../../../apps/auth/account-audit-middleware';
import { FLAT_MOUNTS, type FlatMount } from '../../../apps/auth/audit-coverage';

// tests/tsconfig.json runs with strict: false, so .find() types as T (not
// T | undefined) here and a `!` non-null assertion reads as unnecessary to
// @typescript-eslint/no-unnecessary-type-assertion (error-severity under
// tests/**). A throwing helper avoids the assertion entirely, is immune to
// whichever tsconfig lints it, and fails with a clearer message than a bare
// non-null assertion would if a FLAT_MOUNTS entry is ever renamed.
function mustFindMount(action: string): FlatMount {
  const mount = FLAT_MOUNTS.find((m) => m.action === action);
  if (!mount) throw new Error(`no FLAT_MOUNTS entry for ${action}`);
  return mount;
}

const forgetPasswordMount = mustFindMount('forget-password');
const updateUserMount = mustFindMount('update-user');
const orgCreateMount = mustFindMount('organization.create');

function mockReq(overrides: Partial<Request> = {}): Request {
  return { method: 'POST', path: '/', headers: {}, body: {}, ...overrides } as Request;
}

/**
 * Express 5 strips the mount path under `app.use('/auth/admin', mw)`: a
 * request to /auth/admin/set-role arrives at the middleware with
 * req.path === '/set-role' and req.baseUrl === '/auth/admin', NOT
 * req.path === '/admin/set-role'. Every admin-prefix test below builds
 * requests in that real shape.
 */
function mockAdminReq(overrides: Partial<Request> = {}): Request {
  return mockReq({ baseUrl: '/auth/admin', path: '/set-role', ...overrides });
}

type MockRes = Response & { triggerFinish: () => void; triggerClose: () => void };

function mockRes(): MockRes {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    // M1: Node's real res.writableFinished starts false and becomes true
    // immediately before 'finish' is emitted — never on a bare 'close'.
    // The middleware's M1 guard reads this to distinguish a genuine
    // completion from an aborted connection.
    writableFinished: false,
    write: jest.fn(() => true),
    end: jest.fn(() => res),
    on: jest.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
      return res;
    }),
  } as unknown as MockRes;
  res.triggerFinish = () => {
    (res as unknown as { writableFinished: boolean }).writableFinished = true;
    listeners['finish']?.forEach((cb) => cb());
  };
  res.triggerClose = () => listeners['close']?.forEach((cb) => cb());
  return res;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockSentryCaptureException.mockClear();
  auth.api.getSession = () => Promise.resolve(null);
});

describe('coverage-rule matrix', () => {
  it('logs a non-GET request under the admin prefix', async () => {
    const req = mockAdminReq({ method: 'POST', path: '/set-role' });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.set-role' }),
      expect.anything()
    );
  });

  it('skips a GET request under the admin prefix that is not in the include list', async () => {
    // /impersonate-user is a known admin action (so this exercises the
    // GET-include gate specifically, not the unknown-path gate below).
    const req = mockAdminReq({ method: 'GET', path: '/impersonate-user' });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('logs a GET request under the admin prefix that IS in the include list', async () => {
    const req = mockAdminReq({ method: 'GET', path: '/get-user' });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.get-user' }),
      expect.anything()
    );
  });

  it.each(['OPTIONS', 'HEAD'])('never logs %s regardless of path', async (method) => {
    const req = mockAdminReq({ method, path: '/set-role' });
    const res = mockRes();
    const next = jest.fn();
    adminPrefixAuditMiddleware()(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });
});

describe('unknown admin path (M2, code review BS#2537 PR #2545)', () => {
  it('skips any request to a path outside the known admin action set, without calling getSession', async () => {
    const getSessionSpy = jest.fn(() => Promise.resolve(null));
    auth.api.getSession = getSessionSpy as never;
    const req = mockAdminReq({ method: 'POST', path: '/not-a-real-admin-action' });
    const res = mockRes();
    const next = jest.fn();
    adminPrefixAuditMiddleware()(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
    res.triggerFinish();
    await flush();
    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('skips an unknown GET admin path too (both gates agree)', async () => {
    const req = mockAdminReq({ method: 'GET', path: '/not-a-real-admin-action' });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });
});

describe('actor + impersonator resolution', () => {
  it('resolves the session user as actor on an authenticated mount', async () => {
    auth.api.getSession = () =>
      Promise.resolve({ user: { id: 'manager-1' }, session: { impersonatedBy: null } } as never);
    const req = mockReq({ path: '/organization/create', body: {} });
    const res = mockRes();
    flatMountAuditMiddleware(orgCreateMount)(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'manager-1' }),
      expect.anything()
    );
  });

  it('attributes an impersonated action to the real manager via impersonatorUserId', async () => {
    auth.api.getSession = () =>
      Promise.resolve({ user: { id: 'dj-being-impersonated' }, session: { impersonatedBy: 'manager-1' } } as never);
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'dj-being-impersonated', impersonatorUserId: 'manager-1' }),
      expect.anything()
    );
  });

  it('leaves actor NULL on a public mount, without calling getSession', async () => {
    const getSessionSpy = jest.fn(() => Promise.resolve(null));
    auth.api.getSession = getSessionSpy as never;
    const req = mockReq({ path: '/reset-password', body: {} });
    const res = mockRes();
    flatMountAuditMiddleware(forgetPasswordMount)(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null }),
      expect.anything()
    );
  });
});

describe('subject extraction', () => {
  it('resolves forget-password subject from email via DB, and never persists the email', async () => {
    db._chain.limit.mockResolvedValueOnce([{ id: 'resolved-user-1' }]);
    const req = mockReq({ path: '/request-password-reset', body: { email: 'dj@wxyc.org' } });
    const res = mockRes();
    res.statusCode = 200;
    flatMountAuditMiddleware(forgetPasswordMount)(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    const call = recordAccountAuditEvent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.subjectUserId).toBe('resolved-user-1');
    expect(JSON.stringify(call)).not.toContain('dj@wxyc.org');
  });

  it('does not resolve forget-password subject on a non-2xx outcome (429-visibility DoS-amplifier guard)', async () => {
    const req = mockReq({ path: '/request-password-reset', body: { email: 'dj@wxyc.org' } });
    const res = mockRes();
    res.statusCode = 429;
    flatMountAuditMiddleware(forgetPasswordMount)(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(db._chain.limit).not.toHaveBeenCalled();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: null, outcome: 429 }),
      expect.anything()
    );
  });

  it('extracts a generic body.userId on an admin-prefix mount', async () => {
    auth.api.getSession = () => Promise.resolve({ user: { id: 'manager-1' }, session: {} } as never);
    const req = mockAdminReq({ path: '/ban-user', body: { userId: 'target-1' } });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: 'target-1' }),
      expect.anything()
    );
  });

  it('rejects an implausible body.userId (L3: email-shaped or oversized values never reach subject_user_id)', async () => {
    auth.api.getSession = () => Promise.resolve({ user: { id: 'manager-1' }, session: {} } as never);
    const req = mockAdminReq({ path: '/ban-user', body: { userId: 'spoofed@wxyc.org' } });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: null }),
      expect.anything()
    );
  });

  it('echoes the resolved actor as subject on a self-service mount', async () => {
    auth.api.getSession = () => Promise.resolve({ user: { id: 'self-1' }, session: {} } as never);
    const req = mockReq({ path: '/update-user', body: {} });
    const res = mockRes();
    flatMountAuditMiddleware(updateUserMount)(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'self-1', subjectUserId: 'self-1' }),
      expect.anything()
    );
  });
});

describe('error_code capture (≥400 JSON bodies only)', () => {
  it('captures a better-auth-shaped { message, code } string body', async () => {
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.statusCode = 403;
    res.end(JSON.stringify({ message: 'Forbidden', code: 'FORBIDDEN' }));
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'FORBIDDEN', outcome: 403 }),
      expect.anything()
    );
  });

  // HIGH 2 (code review BS#2537 PR #2545): better-call's setResponse pumps
  // response.body.getReader() values into res.write(value) as plain
  // Uint8Array chunks — NOT Buffers (Buffer.isBuffer is false for a raw
  // Uint8Array) and NOT strings. This is the shape every real better-auth
  // ≥400 response actually arrives in; the original suite only ever wrote
  // strings via res.end(...), which is why the drop went unnoticed.
  it('captures a Uint8Array chunk in the real better-call shape (not a Buffer, not a string)', async () => {
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.statusCode = 403;
    const chunk = new TextEncoder().encode(JSON.stringify({ code: 'FORBIDDEN' }));
    expect(Buffer.isBuffer(chunk)).toBe(false);
    expect(chunk).toBeInstanceOf(Uint8Array);
    res.write(chunk);
    res.end();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'FORBIDDEN', outcome: 403 }),
      expect.anything()
    );
  });

  it('captures an Express typed-error { error, code } body', async () => {
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.statusCode = 409;
    res.end(JSON.stringify({ error: 'Two codes are already live', code: 'passcode_cap_exceeded' }));
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'passcode_cap_exceeded', outcome: 409 }),
      expect.anything()
    );
  });

  it('never captures a body on a 2xx response (PII control)', async () => {
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.statusCode = 200;
    res.end(JSON.stringify({ email: 'someone@wxyc.org', realName: 'A Real Name' }));
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: null }),
      expect.anything()
    );
  });
});

describe('finish/close write-once guard', () => {
  it('logs exactly once when both finish and close fire', async () => {
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    res.triggerClose();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe('M1 close-without-finish guard (code review BS#2537 PR #2545)', () => {
  it('does not record a row when close fires without a prior finish (aborted request)', async () => {
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    // Node's default statusCode is 200 before headers are ever sent — the
    // request aborted before writeHead, so res.statusCode is still 200,
    // and writableFinished stays false because triggerFinish() was never
    // called.
    res.triggerClose();
    await flush();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('does not open the public-mount 2xx subject gate for an aborted request', async () => {
    const req = mockReq({ path: '/request-password-reset', body: { email: 'dj@wxyc.org' } });
    const res = mockRes();
    // Never explicitly set — defaults to 200, exactly like an aborted
    // connection that never reached res.writeHead.
    flatMountAuditMiddleware(forgetPasswordMount)(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerClose();
    await flush();
    expect(db._chain.limit).not.toHaveBeenCalled();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('still logs when finish fires before close (the normal case)', async () => {
    const req = mockAdminReq({ path: '/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    res.triggerClose();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
  });
});
