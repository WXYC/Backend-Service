import { getErrorReporter, setErrorReporter } from '@wxyc/observability';
import type { ErrorReporter } from '@wxyc/observability';

/** The slot `current-reporter.ts` keeps on `globalThis`, shared by every loaded copy of the module. */
const SLOT = Symbol.for('@wxyc/observability/error-reporter');
const readSlot = (): ErrorReporter | undefined => Reflect.get(globalThis, SLOT) as ErrorReporter | undefined;
const clearSlot = (): void => {
  Reflect.deleteProperty(globalThis, SLOT);
};

function spyReporter(): jest.Mocked<ErrorReporter> {
  return {
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
    setRequestTag: jest.fn(),
    flush: jest.fn().mockResolvedValue(true),
  };
}

/** A second, separately loaded copy of the module, as a CJS build loaded beside an ESM one would be. */
function freshModule(): typeof import('@wxyc/observability') {
  let mod!: typeof import('@wxyc/observability');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@wxyc/observability');
  });
  return mod;
}

describe('process-wide error reporter', () => {
  let original: ErrorReporter | undefined;
  beforeEach(() => {
    // Empty the slot so no test sees a reporter an earlier test, or the unit setup, registered.
    original = readSlot();
    clearSlot();
  });
  afterEach(() => {
    clearSlot();
    if (original !== undefined) {
      Reflect.set(globalThis, SLOT, original);
    }
  });

  it('is a no-op that never throws until a reporter is registered', async () => {
    const reporter = getErrorReporter();
    expect(() => {
      reporter.captureException(new Error('boom'), { tags: { a: 'b' } });
      reporter.captureMessage('hello');
      reporter.addBreadcrumb({ message: 'crumb' });
      reporter.setRequestTag('request_id', 'r1');
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

  it('keeps the registration in a global slot, so an emptied slot falls back to the no-op', () => {
    const reporter = spyReporter();
    setErrorReporter(reporter);
    expect(readSlot()).toBe(reporter);

    clearSlot();
    getErrorReporter().captureMessage('dropped');
    expect(getErrorReporter()).not.toBe(reporter);
    expect(reporter.captureMessage).not.toHaveBeenCalled();
  });

  it('shares one registration across separately loaded copies of the module', () => {
    const appCopy = freshModule();
    const libraryCopy = freshModule();
    expect(libraryCopy).not.toBe(appCopy);

    const reporter = spyReporter();
    appCopy.setErrorReporter(reporter);
    expect(libraryCopy.getErrorReporter()).toBe(reporter);
    expect(getErrorReporter()).toBe(reporter);

    const later = spyReporter();
    libraryCopy.setErrorReporter(later);
    expect(appCopy.getErrorReporter()).toBe(later);
  });
});
