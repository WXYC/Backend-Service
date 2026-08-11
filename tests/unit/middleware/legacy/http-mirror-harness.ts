/**
 * Shared harness for unit-testing the HTTP mirror middleware
 * (createHttpMirrorMiddleware handlers in flowsheet.mirror.ts).
 *
 * Simulates the Express response lifecycle the middleware taps. The mock
 * `send` deliberately does NOT capture the payload itself: the middleware's
 * real `tapJsonResponse` wrapper (mirror.middleware.ts) intercepts `res.send`
 * and owns the capture into `res.locals.mirrorData` — an earlier harness
 * revision re-implemented that capture in the mock, which meant the tap's
 * content-type gate, parse fallback, and BS#1513 stash short-circuit had zero
 * effective coverage: deleting the tap's capture line kept every harness
 * suite green (BS#1119 follow-up review). The mock only plays the part of
 * Express's original `send`: it schedules the 'finish' event.
 *
 * jest.mock() calls stay in each test file (they must be hoisted per-module);
 * only the lifecycle plumbing lives here.
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
  };

  // Plays Express's original send: emit 'finish' asynchronously, the way a
  // real response finishes after the body is flushed. Capture is the real
  // tap's job (see the header comment). setImmediate — NOT setTimeout(0) —
  // so ordering against runMiddleware's setImmediate drain is deterministic:
  // a 0ms timer is clamped to 1ms and the drain's turns can all complete
  // before it ever fires, leaving the finish handler unrun.
  res.send.mockImplementation(() => {
    setImmediate(() => emitter.emit('finish'));
    return res;
  });

  return res;
}

export function createMockReq() {
  return {
    ip: '127.0.0.1',
    // The shape the auth middleware actually sets (req.auth, not req.user) —
    // isMirrorEnabled resolves its PostHog distinctId from req.auth.id.
    auth: { id: 'test-user' },
  };
}

/**
 * Invoke a mirror middleware with a JSON payload and wait for the
 * fire-and-forget finish handler to complete.
 *
 * The completion barrier drains a handful of event-loop turns instead of
 * sleeping wall-clock time (the earlier `setTimeout(50)` barrier hung under
 * fake timers and paid 50ms per test): 'finish' fires on the first macrotask,
 * and every await in the finish handler chain resolves against pre-resolved
 * mocks, so a few full loop turns are deterministic headroom. If a mock ever
 * gains real async latency, assertions fail immediately and loudly rather
 * than passing vacuously inside a too-short sleep.
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

  // Trigger send — the middleware's tap wrapper captures the payload into
  // res.locals.mirrorData, then the mock emits finish.
  res.send(JSON.stringify(payload));

  // Drain: the first turn delivers createMockRes's setImmediate finish emit
  // (deliberately NOT a setTimeout — see the note there); the rest cover the
  // awaits inside the handler chain (flag check → execute → per-handler
  // db/http mock awaits).
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
