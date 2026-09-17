/**
 * Unit tests for apps/auth/account-audit-middleware.ts (BS#2537, parent epic
 * #2534): the coverage-rule matrix (non-GET logged, GET skipped unless
 * included, OPTIONS/HEAD always skipped), actor + impersonator resolution,
 * subject extraction (asserting the submitted email never lands in the
 * recorded event), error_code capture for one better-auth-shaped body and
 * one Express typed-error body, the public-mount 2xx subject gate, and the
 * finish/close write-once guard.
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
  return { method: 'POST', path: '/admin/set-role', headers: {}, body: {}, ...overrides } as Request;
}

type MockRes = Response & { triggerFinish: () => void; triggerClose: () => void };

function mockRes(): MockRes {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    write: jest.fn(() => true),
    end: jest.fn(() => res),
    on: jest.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
      return res;
    }),
  } as unknown as MockRes;
  res.triggerFinish = () => listeners['finish']?.forEach((cb) => cb());
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
    const req = mockReq({ method: 'POST', path: '/admin/set-role' });
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
    const req = mockReq({ method: 'GET', path: '/admin/resolve-organization' });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('logs a GET request under the admin prefix that IS in the include list', async () => {
    const req = mockReq({ method: 'GET', path: '/admin/get-user' });
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
    const req = mockReq({ method, path: '/admin/set-role' });
    const res = mockRes();
    const next = jest.fn();
    adminPrefixAuditMiddleware()(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
    res.triggerFinish();
    await flush();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });
});

describe('actor + impersonator resolution', () => {
  it('resolves the session user as actor on an authenticated mount', async () => {
    auth.api.getSession = () =>
      Promise.resolve({ user: { id: 'manager-1' }, session: { impersonatedBy: null } } as never);
    const req = mockReq({ path: '/admin/impersonate-user', body: {} });
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
    const req = mockReq({ path: '/admin/set-role', body: {} });
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
    const req = mockReq({ path: '/admin/ban-user', body: { userId: 'target-1' } });
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
  it('captures a better-auth-shaped { message, code } body', async () => {
    const req = mockReq({ path: '/admin/set-role', body: {} });
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

  it('captures an Express typed-error { error, code } body', async () => {
    const req = mockReq({ path: '/admin/set-role', body: {} });
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
    const req = mockReq({ path: '/admin/set-role', body: {} });
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
    const req = mockReq({ path: '/admin/set-role', body: {} });
    const res = mockRes();
    adminPrefixAuditMiddleware()(req, res, jest.fn() as NextFunction);
    await flush();
    res.triggerFinish();
    res.triggerClose();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
  });
});
