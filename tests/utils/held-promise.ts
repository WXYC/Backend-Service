/**
 * Test helper for asserting that code under test waits on an async dependency.
 *
 * Use it for any test whose name says "before X resolves", "awaits", or "flushes before exit". A mock that
 * returns an already-resolved promise (`mockResolvedValue({})`) cannot tell an `await` from a fire-and-forget
 * call, so the test passes after the `await` is deleted. Hold the dependency pending instead, assert the
 * caller is still pending with `expectPending`, then `release` (or `reject`) and assert it settles.
 *
 *   const send = heldPromise();
 *   mockSend.mockImplementation(send.hold);
 *   const run = withHeartbeat(fn);
 *   await expectPending(run);
 *   send.release({});
 *   await expect(run).resolves.toBe(42);
 */
export interface HeldPromise<T> {
  /** Returns the held promise (the same one on every call); pass it as a mock implementation. */
  hold: () => Promise<T>;
  /** Resolves the held promise. */
  release: (value: T) => void;
  /** Rejects the held promise. */
  reject: (error: unknown) => void;
}

export function heldPromise<T = unknown>(): HeldPromise<T> {
  let release!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const held = new Promise<T>((resolve, rejectFn) => {
    release = resolve;
    reject = rejectFn;
  });
  return { hold: () => held, release, reject };
}

const PENDING_YIELDS = 5;

/**
 * Yields to the event loop several times, then fails if `promise` has settled. Yields with `setImmediate`
 * rather than microtasks because dynamic imports take real loop turns. Do not use with fake timers that
 * fake `setImmediate`.
 */
export async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let i = 0; i < PENDING_YIELDS; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (settled) {
    throw new Error('expected promise to still be pending, but it settled');
  }
}
