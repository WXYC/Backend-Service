import { shouldCaptureExpressError } from '../../../apps/backend/middleware/sentryErrorFilter';
import { LmlClientError } from '@wxyc/lml-client';
import WxycError from '../../../apps/backend/utils/error';

describe('shouldCaptureExpressError', () => {
  it('skips LmlClientError regardless of status code', () => {
    expect(shouldCaptureExpressError(new LmlClientError('LML request timed out', 504))).toBe(false);
    expect(shouldCaptureExpressError(new LmlClientError('LML 500', 502))).toBe(false);
    expect(shouldCaptureExpressError(new LmlClientError('LML not configured', 503))).toBe(false);
  });

  it('captures WxycError with 5xx status (genuine internal errors)', () => {
    expect(shouldCaptureExpressError(new WxycError('database error', 500))).toBe(true);
    expect(shouldCaptureExpressError(new WxycError('upstream failure', 503))).toBe(true);
  });

  it('skips WxycError with 4xx status (client errors are not Sentry-worthy)', () => {
    expect(shouldCaptureExpressError(new WxycError('Album not found', 404))).toBe(false);
    expect(shouldCaptureExpressError(new WxycError('Bad request', 400))).toBe(false);
  });

  it('captures generic Errors (no statusCode means unknown crash)', () => {
    expect(shouldCaptureExpressError(new Error('unexpected'))).toBe(true);
  });

  it('handles statusCode encoded as a string (express convention)', () => {
    const stringStatus = Object.assign(new Error('e'), { statusCode: '504' });
    expect(shouldCaptureExpressError(stringStatus)).toBe(true);

    const stringClient = Object.assign(new Error('e'), { statusCode: '404' });
    expect(shouldCaptureExpressError(stringClient)).toBe(false);
  });

  // Express internals set `status`, not `statusCode` — the router's
  // percent-decode URIError (status: 400, no statusCode) is unauthenticated-
  // reachable via the public GET /concerts/:id (BS#1694) and must not spam
  // Sentry any more than a WxycError 400 does.
  it('reads the `status` alias when `statusCode` is absent (router decode errors)', () => {
    const decodeError = Object.assign(new URIError("Failed to decode param '%ZZ'"), { status: 400 });
    expect(shouldCaptureExpressError(decodeError)).toBe(false);

    const stringStatus = Object.assign(new Error('e'), { status: '404' });
    expect(shouldCaptureExpressError(stringStatus)).toBe(false);

    const serverStatus = Object.assign(new Error('e'), { status: 503 });
    expect(shouldCaptureExpressError(serverStatus)).toBe(true);
  });

  // Suppression is exactly the 4xx band the errorHandler echoes (it shares
  // carriedClientStatus). Anything else that still renders as a generic 500 —
  // a 1xx-3xx-status oddity, a sub-400 statusCode — MUST be captured, or the
  // production 500 is invisible to monitoring.
  it('captures errors whose carried status is outside the echoed 4xx band', () => {
    const redirectish = Object.assign(new Error('upstream said not-modified'), { status: 304 });
    expect(shouldCaptureExpressError(redirectish)).toBe(true);

    const subFourHundred = Object.assign(new Error('e'), { statusCode: 300 });
    expect(shouldCaptureExpressError(subFourHundred)).toBe(true);
  });

  // Both-alias divergence: `status` wins (same helper as errorHandler), so
  // this error answers as a generic 500 — and is captured accordingly.
  it('classifies a both-alias error by `status` first, matching errorHandler', () => {
    const conflicted = Object.assign(new Error('conflicted'), { statusCode: 404, status: 503 });
    expect(shouldCaptureExpressError(conflicted)).toBe(true);
  });
});
