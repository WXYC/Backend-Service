const mockPostHogInstance = {
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

const mockGetPostHogClient = jest.fn(() => mockPostHogInstance);

jest.mock('../../../../apps/backend/utils/posthog', () => ({
  getPostHogClient: mockGetPostHogClient,
}));

jest.mock('../../../../apps/backend/middleware/legacy/commandqueue.mirror', () => ({
  MirrorCommandQueue: {
    instance: jest.fn(() => ({
      enqueue: jest.fn(),
    })),
  },
}));

import { createBackendMirrorMiddleware } from '../../../../apps/backend/middleware/legacy/mirror.middleware';
import { Request, Response } from 'express';
import { EventEmitter } from 'events';

function createMockReqRes() {
  // req.auth is what the auth middleware sets — req.user is never assigned by
  // anything in this codebase. Building the dead shape here is what let the
  // `req.user?.id` read survive: every assertion silently ran against the
  // req.ip fallback instead of a real DJ identity (BS#1119 follow-up review).
  const req = { auth: { id: 'user-1' }, ip: '127.0.0.1' } as unknown as Request;

  const res = new EventEmitter() as Response & EventEmitter;
  res.statusCode = 200;
  (res as any).locals = {};
  res.getHeader = jest.fn().mockReturnValue('application/json');
  const origSend = jest.fn().mockReturnThis();
  res.send = origSend;

  return { req, res };
}

describe('PostHog client usage', () => {
  const origApiKey = process.env.POSTHOG_API_KEY;

  beforeEach(() => {
    process.env.POSTHOG_API_KEY = 'test-key';
    mockGetPostHogClient.mockClear();
    mockPostHogInstance.isFeatureEnabled.mockClear();
    mockPostHogInstance.shutdown.mockClear();
  });

  afterEach(() => {
    if (origApiKey === undefined) {
      delete process.env.POSTHOG_API_KEY;
    } else {
      process.env.POSTHOG_API_KEY = origApiKey;
    }
  });

  it('uses the shared PostHog singleton from utils/posthog', async () => {
    const createCommand = jest.fn().mockResolvedValue(['SQL1']);
    const middleware = createBackendMirrorMiddleware(createCommand);

    const { req: req1, res: res1 } = createMockReqRes();
    const { req: req2, res: res2 } = createMockReqRes();
    const next = jest.fn();

    await middleware(req1, res1, next);
    await middleware(req2, res2, next);

    // Send responses to populate mirrorData
    res1.send(JSON.stringify({ ok: true }));
    res2.send(JSON.stringify({ ok: true }));

    // Trigger finish events
    res1.emit('finish');
    res2.emit('finish');

    // Allow async callbacks to settle
    await new Promise((r) => setTimeout(r, 50));

    // getPostHogClient is called per-request, but it returns the same singleton
    expect(mockGetPostHogClient).toHaveBeenCalled();
    expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledTimes(2);
  });

  it('evaluates the flag against the authenticated user, not the request IP', async () => {
    // The regression pin for the identity itself: without asserting the
    // distinctId, reverting to `req.user?.id` keeps this whole file green
    // while every evaluation silently degrades to one EC2-local req.ip.
    // Registrations that can name a show pass a resolveFlagIdentity instead
    // (the show's primary DJ); this bare one falls back to the caller.
    const middleware = createBackendMirrorMiddleware(jest.fn().mockResolvedValue(['SQL1']));
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith('backend-mirror', 'user-1');
  });

  it('prefers a registration-supplied show identity over the caller', async () => {
    // The per-SHOW decision: every payload in one show must resolve the same
    // flag value, or a mixed-DJ show reaches tubafrenzy half-mirrored — the
    // one state legacy-mirror-reconcile refuses to auto-heal.
    const middleware = createBackendMirrorMiddleware<{ ok: boolean }>(jest.fn().mockResolvedValue(['SQL1']), {
      resolveFlagIdentity: () => Promise.resolve('primary-dj-of-the-show'),
    });
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith('backend-mirror', 'primary-dj-of-the-show');
  });

  it('falls back to the caller when the show-identity lookup throws', async () => {
    const middleware = createBackendMirrorMiddleware<{ ok: boolean }>(jest.fn().mockResolvedValue(['SQL1']), {
      resolveFlagIdentity: () => Promise.reject(new Error('db down')),
    });
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 50));

    // A failed identity lookup must not fail the flag check closed, and must
    // not throw into the mirror's Sentry path either.
    expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith('backend-mirror', 'user-1');
  });
});

describe('mirror flag observability log line', () => {
  const origApiKey = process.env.POSTHOG_API_KEY;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    mockGetPostHogClient.mockClear();
    mockPostHogInstance.isFeatureEnabled.mockClear();
    mockPostHogInstance.shutdown.mockClear();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (origApiKey === undefined) {
      delete process.env.POSTHOG_API_KEY;
    } else {
      process.env.POSTHOG_API_KEY = origApiKey;
    }
    consoleLogSpy.mockRestore();
  });

  async function runMiddlewareOnce() {
    const createCommand = jest.fn().mockResolvedValue(['SQL1']);
    const middleware = createBackendMirrorMiddleware(createCommand);
    const { req, res } = createMockReqRes();
    const next = jest.fn();

    await middleware(req, res, next);
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 50));
  }

  it('logs enabled=true source=env-default when POSTHOG_API_KEY is unset', async () => {
    delete process.env.POSTHOG_API_KEY;

    await runMiddlewareOnce();

    expect(consoleLogSpy).toHaveBeenCalledWith('[mirror] enabled=true source=env-default');
    expect(mockGetPostHogClient).not.toHaveBeenCalled();
  });

  it('logs enabled=true source=posthog when the flag resolves true', async () => {
    process.env.POSTHOG_API_KEY = 'test-key';
    mockPostHogInstance.isFeatureEnabled.mockResolvedValueOnce(true);

    await runMiddlewareOnce();

    expect(consoleLogSpy).toHaveBeenCalledWith('[mirror] enabled=true source=posthog');
  });

  it('logs enabled=false source=posthog when the flag resolves false', async () => {
    process.env.POSTHOG_API_KEY = 'test-key';
    mockPostHogInstance.isFeatureEnabled.mockResolvedValueOnce(false);

    await runMiddlewareOnce();

    expect(consoleLogSpy).toHaveBeenCalledWith('[mirror] enabled=false source=posthog');
  });

  it('logs enabled=false source=posthog-default when the flag resolves undefined (fail-closed)', async () => {
    process.env.POSTHOG_API_KEY = 'test-key';
    mockPostHogInstance.isFeatureEnabled.mockResolvedValueOnce(undefined);

    await runMiddlewareOnce();

    expect(consoleLogSpy).toHaveBeenCalledWith('[mirror] enabled=false source=posthog-default');
  });
});
