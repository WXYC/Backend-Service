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
 * Admin-prefix requests are built in the Express-real, mount-stripped shape
 * (`mockAdminReq`) — that shape is exactly what let the HIGH 1
 * mount-path-stripping bug (code review BS#2537 PR #2545) ship pinned by
 * fictions in the original suite.
 *
 * Item 17 (simplify pass, code review BS#2537 PR #2545 follow-up): three
 * local helpers — `start` (invoke a middleware, flush), `settle` (trigger
 * 'finish', flush), `expectAudited` (assert the recorded row) — collapse
 * the repeated drive/assert sequences below. Tests that interleave
 * `res.statusCode`/body writes between starting and settling keep manual
 * driving (`res.triggerFinish()`/`res.triggerClose()` called directly),
 * since those two steps can't be collapsed without losing the interleave.
 *
 * `flatMountAuditMiddleware` is no longer exported (item 7: the ~20
 * per-mount Express layers collapsed into the two `mountPublicAccountAudit`/
 * `mountAuthenticatedAccountAudit` dispatch layers) — flat-mount behavior is
 * exercised through those two exports via `captureMount`, which fakes just
 * enough of an Express `app` to capture the ONE middleware function each
 * one registers.
 */
import { jest } from '@jest/globals';
import type { Express, NextFunction, Request, Response } from 'express';

const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

import { auth } from '../../mocks/authentication.mock';
import { db, recordAccountAuditEvent } from '../../mocks/database.mock';
import {
  adminPrefixAuditMiddleware,
  mountAuthenticatedAccountAudit,
  mountPublicAccountAudit,
} from '../../../apps/auth/account-audit-middleware';
import { FLAT_MOUNTS, type FlatMount } from '../../../apps/auth/audit-coverage';

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

// tests/tsconfig.json runs with strict: false, so .find() types as T (not
// T | undefined) here and a `!` non-null assertion reads as unnecessary to
// @typescript-eslint/no-unnecessary-type-assertion (error-severity under
// tests/**). A throwing helper avoids the assertion entirely.
function mustFindMount(action: string): FlatMount {
  const mount = FLAT_MOUNTS.find((m) => m.action === action);
  if (!mount) throw new Error(`no FLAT_MOUNTS entry for ${action}`);
  return mount;
}

const forgetPasswordMount = mustFindMount('forget-password');
const updateUserMount = mustFindMount('update-user');
const orgCreateMount = mustFindMount('organization.create');
const deleteUserMount = mustFindMount('delete-user');

/**
 * Captures the ONE middleware function a `mountPublicAccountAudit`/
 * `mountAuthenticatedAccountAudit` call registers via `app.use('/auth', ...)`.
 * L2 (code review BS#2537 PR #2545, second round): also captures the PATH
 * argument, so tests can pin that both dispatch layers register at '/auth'
 * rather than assuming it.
 */
function captureMount(mountFn: (app: Express) => void): { middleware: Middleware; path: string } {
  let middleware: Middleware | undefined;
  let path: string | undefined;
  const fakeApp = {
    use: (usePath: string, mw: Middleware) => {
      path = usePath;
      middleware = mw;
    },
  } as unknown as Express;
  mountFn(fakeApp);
  if (!middleware || path === undefined) throw new Error('mount function never called app.use');
  return { middleware, path };
}

const publicMount = captureMount(mountPublicAccountAudit);
const authenticatedMount = captureMount(mountAuthenticatedAccountAudit);
const dispatchPublic = publicMount.middleware;
const dispatchAuthenticated = authenticatedMount.middleware;

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

/** Invoke `mw` against `req`, flush, and return `{ res, next }` for further driving. */
async function start(mw: Middleware, req: Request): Promise<{ res: MockRes; next: jest.Mock }> {
  const res = mockRes();
  const next = jest.fn();
  mw(req, res, next as NextFunction);
  await flush();
  return { res, next };
}

/** Trigger 'finish' and flush — the common no-interleaved-write case. */
async function settle(res: MockRes): Promise<void> {
  res.triggerFinish();
  await flush();
}

function expectAudited(fields: Record<string, unknown>): void {
  expect(recordAccountAuditEvent).toHaveBeenCalledWith(expect.objectContaining(fields), expect.anything());
}

beforeEach(() => {
  mockSentryCaptureException.mockClear();
  auth.api.getSession = () => Promise.resolve(null);
});

describe('coverage-rule matrix', () => {
  it('logs a non-GET request under the admin prefix', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ method: 'POST', path: '/set-role' }));
    await settle(res);
    expectAudited({ action: 'admin.set-role' });
  });

  it('skips a GET request under the admin prefix that is not in the include list', async () => {
    // /impersonate-user is a known admin action (so this exercises the
    // GET-include gate specifically, not the unknown-path gate below).
    const { res } = await start(
      adminPrefixAuditMiddleware(),
      mockAdminReq({ method: 'GET', path: '/impersonate-user' })
    );
    await settle(res);
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('logs a GET request under the admin prefix that IS in the include list', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ method: 'GET', path: '/get-user' }));
    await settle(res);
    expectAudited({ action: 'admin.get-user' });
  });

  it.each(['OPTIONS', 'HEAD'])('never logs %s regardless of path', async (method) => {
    const { res, next } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ method, path: '/set-role' }));
    expect(next).toHaveBeenCalled();
    await settle(res);
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });
});

describe('unknown admin path (M2, code review BS#2537 PR #2545)', () => {
  it('skips any request to a path outside the known admin action set, without calling getSession', async () => {
    const getSessionSpy = jest.fn(() => Promise.resolve(null));
    auth.api.getSession = getSessionSpy as never;
    const { res, next } = await start(
      adminPrefixAuditMiddleware(),
      mockAdminReq({ method: 'POST', path: '/not-a-real-admin-action' })
    );
    expect(next).toHaveBeenCalled();
    await settle(res);
    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('skips an unknown GET admin path too (both gates agree)', async () => {
    const { res } = await start(
      adminPrefixAuditMiddleware(),
      mockAdminReq({ method: 'GET', path: '/not-a-real-admin-action' })
    );
    await settle(res);
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });
});

describe('actor + impersonator resolution', () => {
  it('resolves the session user as actor on an authenticated mount', async () => {
    auth.api.getSession = () =>
      Promise.resolve({ user: { id: 'manager-1' }, session: { impersonatedBy: null } } as never);
    const { res } = await start(dispatchAuthenticated, mockReq({ path: orgCreateMount.path, body: {} }));
    await settle(res);
    expectAudited({ actorUserId: 'manager-1' });
  });

  it('attributes an impersonated action to the real manager via impersonatorUserId', async () => {
    auth.api.getSession = () =>
      Promise.resolve({ user: { id: 'dj-being-impersonated' }, session: { impersonatedBy: 'manager-1' } } as never);
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    await settle(res);
    expectAudited({ actorUserId: 'dj-being-impersonated', impersonatorUserId: 'manager-1' });
  });

  it('leaves actor NULL on a public mount, without calling getSession', async () => {
    const getSessionSpy = jest.fn(() => Promise.resolve(null));
    auth.api.getSession = getSessionSpy as never;
    const { res } = await start(dispatchPublic, mockReq({ path: '/reset-password', body: {} }));
    await settle(res);
    expect(getSessionSpy).not.toHaveBeenCalled();
    expectAudited({ actorUserId: null });
  });
});

describe('subject extraction', () => {
  it('resolves forget-password subject from email via DB, and never persists the email', async () => {
    db._chain.limit.mockResolvedValueOnce([{ id: 'resolved-user-1' }]);
    const { res } = await start(
      dispatchPublic,
      mockReq({ path: forgetPasswordMount.path, body: { email: 'dj@wxyc.org' } })
    );
    await settle(res);
    const call = recordAccountAuditEvent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.subjectUserId).toBe('resolved-user-1');
    expect(JSON.stringify(call)).not.toContain('dj@wxyc.org');
  });

  it('does not resolve forget-password subject on a non-2xx outcome (429-visibility DoS-amplifier guard)', async () => {
    const { res } = await start(
      dispatchPublic,
      mockReq({ path: forgetPasswordMount.path, body: { email: 'dj@wxyc.org' } })
    );
    res.statusCode = 429;
    await settle(res);
    expect(db._chain.limit).not.toHaveBeenCalled();
    expectAudited({ subjectUserId: null, outcome: 429 });
  });

  it('extracts a generic body.userId on an admin-prefix mount', async () => {
    auth.api.getSession = () => Promise.resolve({ user: { id: 'manager-1' }, session: {} } as never);
    const { res } = await start(
      adminPrefixAuditMiddleware(),
      mockAdminReq({ path: '/ban-user', body: { userId: 'target-1' } })
    );
    await settle(res);
    expectAudited({ subjectUserId: 'target-1' });
  });

  it('rejects an implausible body.userId (L3: email-shaped or oversized values never reach subject_user_id)', async () => {
    auth.api.getSession = () => Promise.resolve({ user: { id: 'manager-1' }, session: {} } as never);
    const { res } = await start(
      adminPrefixAuditMiddleware(),
      mockAdminReq({ path: '/ban-user', body: { userId: 'spoofed@wxyc.org' } })
    );
    await settle(res);
    expectAudited({ subjectUserId: null });
  });

  it('echoes the resolved actor as subject on a self-service mount', async () => {
    auth.api.getSession = () => Promise.resolve({ user: { id: 'self-1' }, session: {} } as never);
    const { res } = await start(dispatchAuthenticated, mockReq({ path: updateUserMount.path, body: {} }));
    await settle(res);
    expectAudited({ actorUserId: 'self-1', subjectUserId: 'self-1' });
  });
});

describe('error_code capture (≥400 JSON bodies only) — manual driving (interleaved statusCode/body writes)', () => {
  it('captures a better-auth-shaped { message, code } string body', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    res.statusCode = 403;
    res.end(JSON.stringify({ message: 'Forbidden', code: 'FORBIDDEN' }));
    await settle(res);
    expectAudited({ errorCode: 'FORBIDDEN', outcome: 403 });
  });

  // HIGH 2 (code review BS#2537 PR #2545): better-call's setResponse pumps
  // response.body.getReader() values into res.write(value) as plain
  // Uint8Array chunks — NOT Buffers (Buffer.isBuffer is false for a raw
  // Uint8Array) and NOT strings. This is the shape every real better-auth
  // ≥400 response actually arrives in; the original suite only ever wrote
  // strings via res.end(...), which is why the drop went unnoticed.
  it('captures a Uint8Array chunk in the real better-call shape (not a Buffer, not a string)', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    res.statusCode = 403;
    const chunk = new TextEncoder().encode(JSON.stringify({ code: 'FORBIDDEN' }));
    expect(Buffer.isBuffer(chunk)).toBe(false);
    expect(chunk).toBeInstanceOf(Uint8Array);
    res.write(chunk);
    res.end();
    await settle(res);
    expectAudited({ errorCode: 'FORBIDDEN', outcome: 403 });
  });

  it('captures an Express typed-error { error, code } body', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    res.statusCode = 409;
    res.end(JSON.stringify({ error: 'Two codes are already live', code: 'passcode_cap_exceeded' }));
    await settle(res);
    expectAudited({ errorCode: 'passcode_cap_exceeded', outcome: 409 });
  });

  it('never captures a body on a 2xx response (PII control)', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    res.statusCode = 200;
    res.end(JSON.stringify({ email: 'someone@wxyc.org', realName: 'A Real Name' }));
    await settle(res);
    expectAudited({ errorCode: null });
  });
});

describe('finish/close write-once guard — manual driving (both events)', () => {
  it('logs exactly once when both finish and close fire', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    res.triggerFinish();
    res.triggerClose();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe('M1 close-without-finish guard (code review BS#2537 PR #2545) — manual driving (close only)', () => {
  it('does not record a row when close fires without a prior finish (aborted request)', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    // Node's default statusCode is 200 before headers are ever sent — the
    // request aborted before writeHead, so res.statusCode is still 200,
    // and writableFinished stays false because triggerFinish() was never
    // called.
    res.triggerClose();
    await flush();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('does not open the public-mount 2xx subject gate for an aborted request', async () => {
    const { res } = await start(
      dispatchPublic,
      mockReq({ path: forgetPasswordMount.path, body: { email: 'dj@wxyc.org' } })
    );
    res.triggerClose();
    await flush();
    expect(db._chain.limit).not.toHaveBeenCalled();
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });

  it('still logs when finish fires before close (the normal case)', async () => {
    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    res.triggerFinish();
    res.triggerClose();
    await flush();
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe('serializeSessionRead carve-out (MEDIUM 1, code review BS#2537 PR #2545, second round)', () => {
  it('defers next() until the session promise settles on a flagged action (delete-user)', async () => {
    let resolveSession!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveSession = resolve;
    });
    auth.api.getSession = () => pending as never;

    const res = mockRes();
    const next = jest.fn();
    dispatchAuthenticated(mockReq({ path: deleteUserMount.path, body: {} }), res, next as NextFunction);
    await flush();
    expect(next).not.toHaveBeenCalled();

    resolveSession({ user: { id: 'self-1' }, session: {} });
    await flush();
    expect(next).toHaveBeenCalled();
  });

  it('calls next() synchronously (does not wait on the session promise) on an unflagged action (update-user)', async () => {
    let resolveSession!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveSession = resolve;
    });
    auth.api.getSession = () => pending as never;

    const res = mockRes();
    const next = jest.fn();
    dispatchAuthenticated(mockReq({ path: updateUserMount.path, body: {} }), res, next as NextFunction);
    await flush();
    expect(next).toHaveBeenCalled();

    resolveSession({ user: { id: 'self-1' }, session: {} }); // settle so the promise doesn't dangle into the next test
    await flush();
  });
});

describe('dispatch layer (L2, code review BS#2537 PR #2545, second round)', () => {
  it('registers both mount functions at /auth', () => {
    expect(publicMount.path).toBe('/auth');
    expect(authenticatedMount.path).toBe('/auth');
  });

  it('normalizes a trailing slash before the Map lookup', async () => {
    const { res } = await start(
      dispatchPublic,
      mockReq({ path: `${forgetPasswordMount.path}/`, body: { email: 'dj@wxyc.org' } })
    );
    await settle(res);
    expectAudited({ action: forgetPasswordMount.action });
  });

  it('falls through to the original next() untouched on a Map miss', async () => {
    const { res, next } = await start(dispatchPublic, mockReq({ path: '/not-a-real-flat-mount', body: {} }));
    expect(next).toHaveBeenCalled();
    await settle(res);
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();
  });
});

describe('await sessionPromise inside finishOnce (L3, code review BS#2537 PR #2545, second round)', () => {
  // This is the regression test for the line that makes the concurrent
  // (non-serializeSessionRead) path safe: without `await sessionPromise` in
  // finishOnce, a 'finish' that fires before getSession resolves would
  // record the row with actorId still null. Uses a manually-resolvable
  // promise so 'finish' can be driven strictly before the session settles.
  it('still records the resolved actor when finish fires before getSession settles', async () => {
    let resolveSession!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveSession = resolve;
    });
    auth.api.getSession = () => pending as never;

    const { res } = await start(adminPrefixAuditMiddleware(), mockAdminReq({ path: '/set-role', body: {} }));
    res.triggerFinish();
    await flush();
    // finishOnce is suspended inside `await sessionPromise` — the write
    // must not have happened yet.
    expect(recordAccountAuditEvent).not.toHaveBeenCalled();

    resolveSession({ user: { id: 'late-actor' }, session: {} });
    await flush();
    expectAudited({ actorUserId: 'late-actor' });
  });
});
