import { resolveTracesSampleRate as resolveAuth } from '../../../apps/auth/sentry-config';
import { resolveTracesSampleRate as resolveBackend } from '../../../apps/backend/sentry-config';

describe.each([
  ['auth', resolveAuth],
  ['backend', resolveBackend],
])('%s resolveTracesSampleRate', (_app, resolve) => {
  it('returns 1.0 when SENTRY_TRACES_SAMPLE_RATE is unset (preserves post-#767 default)', () => {
    expect(resolve(undefined)).toBe(1.0);
  });

  it('returns the parsed value for valid 0-to-1 inputs', () => {
    expect(resolve('0')).toBe(0);
    expect(resolve('0.1')).toBe(0.1);
    expect(resolve('0.5')).toBe(0.5);
    expect(resolve('1')).toBe(1);
    expect(resolve('1.0')).toBe(1);
  });

  it('falls back to 1.0 for malformed or out-of-range values without crashing init', () => {
    expect(resolve('abc')).toBe(1.0);
    expect(resolve('-0.5')).toBe(1.0);
    expect(resolve('1.5')).toBe(1.0);
    expect(resolve('NaN')).toBe(1.0);
    expect(resolve('Infinity')).toBe(1.0);
  });
});
