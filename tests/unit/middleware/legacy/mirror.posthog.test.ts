const mockPostHogInstance = {
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

const mockGetPostHogClient = jest.fn(() => mockPostHogInstance);
const mockEnqueue = jest.fn();
const mockAddBreadcrumb = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('../../../../apps/backend/utils/posthog', () => ({
  getPostHogClient: mockGetPostHogClient,
}));

jest.mock('@sentry/node', () => ({
  addBreadcrumb: mockAddBreadcrumb,
  captureException: mockCaptureException,
  withScope: (fn: (scope: { setTags: jest.Mock; setExtra: jest.Mock }) => void) =>
    fn({
      setTags: jest.fn(),
      setExtra: jest.fn(),
    }),
}), { virtual: true });

jest.mock('../../../../apps/backend/middleware/legacy/commandqueue.mirror', () => ({
  MirrorCommandQueue: {
    instance: jest.fn(() => ({
      enqueue: mockEnqueue,
    })),
  },
}));

import { createBackendMirrorMiddleware } from '../../../../apps/backend/middleware/legacy/mirror.middleware';
import { Request, Response } from 'express';
import { EventEmitter } from 'events';

function createMockReqRes() {
  const req = {
    user: { id: 'user-1' },
    ip: '127.0.0.1',
    method: 'POST',
    path: '/flowsheet',
    get: jest.fn((k: string) => (k.toLowerCase() === 'x-request-id' ? 'req-1' : undefined)),
  } as unknown as Request;

  const res = new EventEmitter() as Response & EventEmitter;
  res.statusCode = 200;
  (res as any).locals = {};
  res.getHeader = jest.fn((k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : undefined)) as any;
  const origSend = jest.fn().mockReturnThis();
  res.send = origSend;

  return { req, res };
}

describe('PostHog client usage', () => {
  const origApiKey = process.env.POSTHOG_API_KEY;

  beforeEach(() => {
    process.env.POSTHOG_API_KEY = 'test-key';
    mockEnqueue.mockReset();
    mockEnqueue.mockReturnValue({ id: 'cmd-1', statementsCount: 1, context: { operation: 'flowsheet.test' } });
    mockGetPostHogClient.mockClear();
    mockPostHogInstance.isFeatureEnabled.mockClear();
    mockPostHogInstance.shutdown.mockClear();
    mockAddBreadcrumb.mockClear();
    mockCaptureException.mockClear();
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
    const middleware = createBackendMirrorMiddleware('flowsheet.test', createCommand);

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

  it('skips when response status is not successful', async () => {
    const createCommand = jest.fn().mockResolvedValue(['SQL1']);
    const middleware = createBackendMirrorMiddleware('flowsheet.test', createCommand);
    const { req, res } = createMockReqRes();
    res.statusCode = 500;

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 20));

    expect(mockPostHogInstance.isFeatureEnabled).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(createCommand).not.toHaveBeenCalled();
  });

  it('skips when mirrorData is missing', async () => {
    const createCommand = jest.fn().mockResolvedValue(['SQL1']);
    const middleware = createBackendMirrorMiddleware('flowsheet.test', createCommand);
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    // no send => no mirrorData capture
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 20));

    expect(mockPostHogInstance.isFeatureEnabled).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('skips enqueue when feature flag is disabled', async () => {
    mockPostHogInstance.isFeatureEnabled.mockResolvedValueOnce(false);
    const createCommand = jest.fn().mockResolvedValue(['SQL1']);
    const middleware = createBackendMirrorMiddleware('flowsheet.test', createCommand);
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ ok: true, show_id: 10 }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 20));

    expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(createCommand).not.toHaveBeenCalled();
  });

  it('enqueues with context when feature flag is enabled', async () => {
    const createCommand = jest.fn().mockResolvedValue(['SQL1']);
    const middleware = createBackendMirrorMiddleware('flowsheet.test', createCommand);
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ show_id: 55, dj_id: 'dj-22' }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 20));

    expect(mockEnqueue).toHaveBeenCalledWith(
      ['SQL1'],
      expect.objectContaining({
        operation: 'flowsheet.test',
        requestId: 'req-1',
        showId: 55,
        djId: 'dj-22',
      })
    );
  });

  it('captures exception when createCommand throws', async () => {
    const createCommand = jest.fn().mockRejectedValue(new Error('create fail'));
    const middleware = createBackendMirrorMiddleware('flowsheet.test', createCommand);
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 20));

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it('logs warning path when queue is dead (enqueue returns null)', async () => {
    mockEnqueue.mockReturnValueOnce(null);
    const createCommand = jest.fn().mockResolvedValue(['SQL1']);
    const middleware = createBackendMirrorMiddleware('flowsheet.test', createCommand);
    const { req, res } = createMockReqRes();

    await middleware(req, res, jest.fn());
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 20));

    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'mirror',
        level: 'warning',
      })
    );
  });
});
