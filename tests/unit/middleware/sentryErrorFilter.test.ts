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
});
