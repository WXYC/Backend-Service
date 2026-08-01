/**
 * Unit tests for logger.errorMessage -- specifically the `.cause` surfacing
 * added after the enriched_no_match-digest date-serializer failure logged only
 * Drizzle's opaque "Failed query: ..." wrapper, hiding the real cause. Sentry
 * init/log/capture are exercised by the job at runtime, not here.
 */
import { describe, it, expect } from '@jest/globals';
import { errorMessage } from '../../../../jobs/metadata-no-match-digest/logger';

describe('logger.errorMessage', () => {
  it('returns the plain message when there is no cause', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('appends an Error cause message (the DrizzleQueryError -> real driver error case)', () => {
    const wrapped = new Error('Failed query: SELECT ...');
    (wrapped as { cause?: unknown }).cause = new TypeError('The "string" argument must be of type string');
    expect(errorMessage(wrapped)).toBe(
      'Failed query: SELECT ... [cause: The "string" argument must be of type string]'
    );
  });

  it('appends a non-Error cause via String()', () => {
    const wrapped = new Error('outer');
    (wrapped as { cause?: unknown }).cause = 'inner detail';
    expect(errorMessage(wrapped)).toBe('outer [cause: inner detail]');
  });

  it('does not duplicate when the cause message equals the wrapper message', () => {
    const wrapped = new Error('same');
    (wrapped as { cause?: unknown }).cause = new Error('same');
    expect(errorMessage(wrapped)).toBe('same');
  });

  it('coerces a non-Error throw to a string', () => {
    expect(errorMessage('just a string')).toBe('just a string');
    expect(errorMessage({ code: 42 })).toBe('[object Object]');
  });
});
