import { getErrorReporter, setErrorReporter } from '@wxyc/observability';
import type { ErrorReporter } from '@wxyc/observability';

function spyReporter(): jest.Mocked<ErrorReporter> {
  return {
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
    setRequestTag: jest.fn(),
    recordCounter: jest.fn(),
    flush: jest.fn().mockResolvedValue(true),
  };
}

/** A copy of the module with its own holder, still holding the default. */
function freshModule(): typeof import('@wxyc/observability') {
  let mod!: typeof import('@wxyc/observability');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@wxyc/observability');
  });
  return mod;
}

describe('process-wide error reporter', () => {
  let original: ErrorReporter;
  beforeEach(() => {
    original = getErrorReporter();
  });
  afterEach(() => setErrorReporter(original));

  it('is a no-op that never throws until a reporter is registered', async () => {
    const reporter = freshModule().getErrorReporter();
    expect(() => {
      reporter.captureException(new Error('boom'), { tags: { a: 'b' } });
      reporter.captureMessage('hello');
      reporter.addBreadcrumb({ message: 'crumb' });
      reporter.setRequestTag('request_id', 'r1');
      reporter.recordCounter('c', 1);
    }).not.toThrow();
    await expect(reporter.flush()).resolves.toBe(true);
  });

  it('returns the registered reporter', () => {
    const reporter = spyReporter();
    setErrorReporter(reporter);
    expect(getErrorReporter()).toBe(reporter);
  });

  it('replaces an earlier registration with a later one', () => {
    const first = spyReporter();
    const second = spyReporter();
    setErrorReporter(first);
    setErrorReporter(second);
    getErrorReporter().captureMessage('x');
    expect(second.captureMessage).toHaveBeenCalledWith('x');
    expect(first.captureMessage).not.toHaveBeenCalled();
  });
});
