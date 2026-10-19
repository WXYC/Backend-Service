import { jest } from '@jest/globals';
import { getErrorReporter, setErrorReporter } from '@wxyc/observability';
import type { ErrorReporter } from '@wxyc/observability';

/** An `ErrorReporter` whose every method is a `jest.fn()`, so a call to any method is assertable rather than a `TypeError`. */
export type SpyReporter = { [K in keyof ErrorReporter]: jest.MockedFunction<ErrorReporter[K]> };

/** A complete spy reporter; `flush` resolves `true`. Build the double here rather than casting a partial object. */
export function createSpyReporter(): SpyReporter {
  return {
    captureException: jest.fn<ErrorReporter['captureException']>(),
    captureMessage: jest.fn<ErrorReporter['captureMessage']>(),
    addBreadcrumb: jest.fn<ErrorReporter['addBreadcrumb']>(),
    setRequestTag: jest.fn<ErrorReporter['setRequestTag']>(),
    flush: jest.fn<ErrorReporter['flush']>().mockResolvedValue(true),
  };
}

/**
 * Registers a fresh spy reporter before each test and restores the reporter that was registered
 * (the unit setup's) after it. Call at describe or file scope; assert on the returned object.
 */
export function useSpyReporter(): SpyReporter {
  let previous: ErrorReporter;
  const holder = createSpyReporter();
  beforeEach(() => {
    previous = getErrorReporter();
    for (const key of Object.keys(holder) as (keyof SpyReporter)[]) {
      holder[key].mockReset();
    }
    holder.flush.mockResolvedValue(true);
    setErrorReporter(holder);
  });
  afterEach(() => {
    setErrorReporter(previous);
  });
  return holder;
}

/**
 * Body for a `jest.mock('@wxyc/observability', ...)` factory: the real barrel with only the named
 * exports replaced, so `getErrorReporter` and `setErrorReporter` survive. Call it through
 * `requireActual` so the helper is not evaluated while the barrel is still being mocked:
 *
 *   jest.mock('@wxyc/observability', () =>
 *     jest.requireActual<typeof import('../../utils/observability')>('../../utils/observability').mockObservabilityBarrel({ logCounter: mockLogCounter }));
 */
export function mockObservabilityBarrel(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...jest.requireActual<Record<string, unknown>>('@wxyc/observability'), ...overrides };
}
