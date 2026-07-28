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
  const req = { user: { id: 'user-1' }, ip: '127.0.0.1' } as unknown as Request;

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
