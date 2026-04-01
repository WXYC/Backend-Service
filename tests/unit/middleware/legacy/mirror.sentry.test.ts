const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

const mockPostHogInstance = {
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../../../apps/backend/utils/posthog', () => ({
  getPostHogClient: jest.fn(() => mockPostHogInstance),
}));

jest.mock('../../../../apps/backend/middleware/legacy/commandqueue.mirror', () => ({
  MirrorCommandQueue: {
    instance: jest.fn(() => ({
      enqueue: jest.fn(),
    })),
  },
}));

import {
  createBackendMirrorMiddleware,
  createHttpMirrorMiddleware,
} from '../../../../apps/backend/middleware/legacy/mirror.middleware';
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

describe('mirror middleware Sentry reporting', () => {
  beforeEach(() => {
    process.env.POSTHOG_API_KEY = 'test-key';
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.POSTHOG_API_KEY;
  });

  it('reports SQL mirror errors to Sentry with subsystem=legacy-mirror, variant=sql', async () => {
    const mirrorError = new Error('SQL command failed');
    const createCommand = jest.fn().mockRejectedValue(mirrorError);
    const middleware = createBackendMirrorMiddleware(createCommand);

    const { req, res } = createMockReqRes();
    const next = jest.fn();

    await middleware(req, res, next);
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 50));

    expect(mockCaptureException).toHaveBeenCalledWith(
      mirrorError,
      expect.objectContaining({ tags: { subsystem: 'legacy-mirror', variant: 'sql' } })
    );
  });

  it('reports HTTP mirror errors to Sentry with subsystem=legacy-mirror, variant=http', async () => {
    const mirrorError = new Error('HTTP sync failed');
    const execute = jest.fn().mockRejectedValue(mirrorError);
    const middleware = createHttpMirrorMiddleware(execute);

    const { req, res } = createMockReqRes();
    const next = jest.fn();

    await middleware(req, res, next);
    res.send(JSON.stringify({ ok: true }));
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 50));

    expect(mockCaptureException).toHaveBeenCalledWith(
      mirrorError,
      expect.objectContaining({ tags: { subsystem: 'legacy-mirror', variant: 'http' } })
    );
  });
});
