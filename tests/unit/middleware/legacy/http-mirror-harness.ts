/**
 * Shared harness for unit-testing the HTTP mirror middleware
 * (createHttpMirrorMiddleware handlers in flowsheet.mirror.ts).
 *
 * Simulates the Express response lifecycle the middleware taps: `send`
 * captures the JSON payload into `res.locals.mirrorData`, then `finish` fires
 * the mirror's async handler. jest.mock() calls stay in each test file (they
 * must be hoisted per-module); only the lifecycle plumbing lives here.
 *
 * Not a test file — the `.test.ts` glob in jest.unit.config.ts skips it.
 */

import { EventEmitter } from 'events';

export function createMockRes(statusCode: number) {
  const emitter = new EventEmitter();
  const locals: Record<string, unknown> = {};
  const res = {
    statusCode,
    locals,
    getHeader: jest.fn().mockReturnValue('application/json'),
    send: jest.fn(),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };

  // After send is called, emit 'finish' to trigger mirror logic
  res.send.mockImplementation((data: unknown) => {
    locals.mirrorData = typeof data === 'string' ? JSON.parse(data) : data;
    setTimeout(() => emitter.emit('finish'), 0);
    return res;
  });

  return res;
}

export function createMockReq() {
  return {
    ip: '127.0.0.1',
    user: { id: 'test-user' },
  };
}

/**
 * Invoke a mirror middleware with a JSON payload and wait for the
 * fire-and-forget finish handler to complete.
 */
export async function runMiddleware(
  middleware: (req: unknown, res: unknown, next: unknown) => Promise<void> | void,
  payload: Record<string, unknown>,
  statusCode = 200
) {
  const req = createMockReq();
  const res = createMockRes(statusCode);
  const next = jest.fn();

  // Middleware may or may not return a promise
  void middleware(req, res, next);
  expect(next).toHaveBeenCalled();

  // Trigger send (which populates mirrorData and emits finish)
  res.send(JSON.stringify(payload));

  // Wait for async finish handler to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
}
