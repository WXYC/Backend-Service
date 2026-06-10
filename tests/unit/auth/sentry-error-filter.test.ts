import { shouldCaptureAuthExpressError } from '../../../apps/auth/sentry-error-filter';
import { ProvisionError } from '../../../apps/auth/provision-user';

describe('shouldCaptureAuthExpressError', () => {
  it('captures generic Errors (no statusCode means unknown crash, e.g. bare TypeError)', () => {
    expect(shouldCaptureAuthExpressError(new Error('unexpected'))).toBe(true);
    expect(shouldCaptureAuthExpressError(new TypeError('cannot read x'))).toBe(true);
  });

  it('skips ProvisionError with 4xx status (client errors are not Sentry-worthy)', () => {
    expect(shouldCaptureAuthExpressError(new ProvisionError(400, 'Invalid role'))).toBe(false);
    expect(shouldCaptureAuthExpressError(new ProvisionError(404, 'Org not found'))).toBe(false);
    expect(shouldCaptureAuthExpressError(new ProvisionError(409, 'Email exists'))).toBe(false);
  });

  it('captures errors with 5xx status (genuine internal errors)', () => {
    const fiveHundred = Object.assign(new Error('db down'), { statusCode: 500 });
    expect(shouldCaptureAuthExpressError(fiveHundred)).toBe(true);

    const fiveOhThree = Object.assign(new Error('upstream'), { statusCode: 503 });
    expect(shouldCaptureAuthExpressError(fiveOhThree)).toBe(true);
  });

  it('handles statusCode encoded as a string (express convention)', () => {
    const stringStatus = Object.assign(new Error('e'), { statusCode: '504' });
    expect(shouldCaptureAuthExpressError(stringStatus)).toBe(true);

    const stringClient = Object.assign(new Error('e'), { statusCode: '404' });
    expect(shouldCaptureAuthExpressError(stringClient)).toBe(false);
  });

  it('reads `status` as a fallback when `statusCode` is absent (express MiddlewareError convention)', () => {
    const errWithStatus = Object.assign(new Error('e'), { status: 401 });
    expect(shouldCaptureAuthExpressError(errWithStatus)).toBe(false);

    const errWith5xxStatus = Object.assign(new Error('e'), { status: 502 });
    expect(shouldCaptureAuthExpressError(errWith5xxStatus)).toBe(true);
  });
});
