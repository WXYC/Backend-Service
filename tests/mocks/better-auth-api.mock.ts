// Mock for `better-auth/api` — the real subpath ships ESM that ts-jest
// can't transform without the ESM preset. `APIError` is the only symbol the
// production code we test under `tests/unit/**` imports from here.
export class APIError extends Error {
  statusCode: number;
  body?: { message?: string; code?: string; error?: string; error_description?: string; [key: string]: unknown };

  constructor(
    status: number | string = 500,
    body?: { message?: string; code?: string; error?: string; error_description?: string; [key: string]: unknown },
    _headers?: unknown,
    statusCode?: number
  ) {
    super(body?.message ?? body?.error ?? 'API Error');
    this.name = 'APIError';
    this.body = body;
    this.statusCode = statusCode ?? (typeof status === 'number' ? status : 500);
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
