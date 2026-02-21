const mockPostHogInstance = {
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

const PostHogConstructor = jest.fn(() => mockPostHogInstance);

jest.mock('posthog-node', () => ({
  PostHog: PostHogConstructor,
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

describe('PostHog client instantiation', () => {
  beforeEach(() => {
    PostHogConstructor.mockClear();
    mockPostHogInstance.isFeatureEnabled.mockClear();
    mockPostHogInstance.shutdown.mockClear();
  });

  it('creates PostHog at most once across multiple requests', async () => {
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

    expect(PostHogConstructor).toHaveBeenCalledTimes(1);
  });
});
