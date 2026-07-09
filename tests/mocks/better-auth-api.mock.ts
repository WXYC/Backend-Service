// Mock for `better-auth/api` — the real subpath ships ESM that ts-jest
// can't transform without the ESM preset. `APIError` is the only symbol the
// production code we test under `tests/unit/**` imports from here.
export class APIError extends Error {
  body: { error?: string; error_description?: string };
  constructor(_status: string, body: { error?: string; error_description?: string }) {
    super(body?.error ?? _status);
    this.body = body;
  }
}

// The `/device/approve` before-hook uses this at runtime, but no unit test
// invokes the hook directly, so the stub is a no-op returning null. If a
// future test needs an authenticated context, replace this with a jest.mock
// override at the top of that spec.
export const getSessionFromCtx = () => Promise.resolve(null);

// Same rationale for createAuthMiddleware — production callers pass a
// handler function; the stub returns it verbatim so `.path`/`.body` code
// paths remain testable when a spec wants to exercise them.
export const createAuthMiddleware = <T>(handler: T): T => handler;
