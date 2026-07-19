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

  // Capture tracks the RESPONSE: suppression applies exactly to the errors
  // errorHandler echoes as trusted client 4xxs (it shares carriedClientStatus,
  // which requires `expose: true` — the http-errors convention — or the
  // router's URIError). A bare string statusCode without expose renders as a
  // generic 500, so it MUST be captured; the 5xx string form was never
  // suppressed.
  it('handles statusCode encoded as a string (express convention)', () => {
    const stringStatus = Object.assign(new Error('e'), { statusCode: '504' });
    expect(shouldCaptureExpressError(stringStatus)).toBe(true);

    const exposedStringClient = Object.assign(new Error('e'), { statusCode: '404', expose: true });
    expect(shouldCaptureExpressError(exposedStringClient)).toBe(false);

    const untrustedStringClient = Object.assign(new Error('e'), { statusCode: '404' });
    expect(shouldCaptureExpressError(untrustedStringClient)).toBe(true);
  });

  // Express internals set `status`, not `statusCode` — the router's
  // percent-decode URIError (status: 400, no statusCode) is unauthenticated-
  // reachable via the public GET /concerts/:id (BS#1694) and must not spam
  // Sentry any more than a WxycError 400 does.
  it('reads the `status` alias when `statusCode` is absent (router decode errors)', () => {
    const decodeError = Object.assign(new URIError("Failed to decode param '%ZZ'"), { status: 400 });
    expect(shouldCaptureExpressError(decodeError)).toBe(false);

    const exposedClient = Object.assign(new Error('e'), { status: '404', expose: true });
    expect(shouldCaptureExpressError(exposedClient)).toBe(false);

    const serverStatus = Object.assign(new Error('e'), { status: 503 });
    expect(shouldCaptureExpressError(serverStatus)).toBe(true);
  });

  // Suppression is exactly the trusted 4xx band the errorHandler echoes.
  // Anything that still renders as a generic 500 — a 1xx-3xx-status oddity,
  // a sub-400 statusCode — MUST be captured, or the production 500 is
  // invisible to monitoring.
  it('captures errors whose carried status is outside the echoed 4xx band', () => {
    const redirectish = Object.assign(new Error('upstream said not-modified'), { status: 304 });
    expect(shouldCaptureExpressError(redirectish)).toBe(true);

    const subFourHundred = Object.assign(new Error('e'), { statusCode: 300 });
    expect(shouldCaptureExpressError(subFourHundred)).toBe(true);
  });

  // The groq-sdk APIError shape (integer `.status` 429/401, no statusCode,
  // no expose, provider body in message) renders as a generic 500 and MUST
  // be captured: a rotated GROQ_API_KEY or sustained provider rate-limiting
  // is a server-side dependency failure, not client noise. This was main's
  // behavior (statusCode undefined → captured); the status-alias read must
  // not regress it.
  it('captures untrusted upstream-SDK 4xx errors (no expose) that render as 500s', () => {
    const groqRateLimit = Object.assign(new Error('429 Rate limit reached for model X in organization org_01abc'), {
      status: 429,
    });
    expect(shouldCaptureExpressError(groqRateLimit)).toBe(true);

    const groqBadKey = Object.assign(new Error('401 Invalid API Key'), { status: 401 });
    expect(shouldCaptureExpressError(groqBadKey)).toBe(true);
  });

  // Both-alias divergence: `status` wins (same helper as errorHandler), so
  // this error answers as a generic 500 — and is captured accordingly.
  it('classifies a both-alias error by `status` first, matching errorHandler', () => {
    const conflicted = Object.assign(new Error('conflicted'), { statusCode: 404, status: 503, expose: true });
    expect(shouldCaptureExpressError(conflicted)).toBe(true);
  });

  // Sentry's expressErrorHandler passes the RAW pipeline value, but
  // errorHandler wraps non-Error throwables in `new Error(String(err))` —
  // dropping any carried status — before classifying, so every non-Error
  // renders as a generic 500. The filter must normalize the same way, or a
  // next()'d plain object with a trusted-looking 4xx would be 500-answered
  // yet capture-suppressed: invisible to monitoring.
  it('captures non-Error throwables regardless of carried properties (they render as 500s)', () => {
    const plainWithStatus = { status: 400, expose: true, message: 'looks legit' } as unknown as Error;
    expect(shouldCaptureExpressError(plainWithStatus)).toBe(true);

    expect(shouldCaptureExpressError('string throw' as unknown as Error)).toBe(true);
    expect(shouldCaptureExpressError(undefined as unknown as Error)).toBe(true);
  });
});
