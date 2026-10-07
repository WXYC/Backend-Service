import { readFileSync } from 'fs';
import { resolve } from 'path';

// v11's `expressIntegration` is the Express error capturer, and its
// `shouldHandleError` wins over the deprecated `setupExpressErrorHandler`'s
// options (BS#2949). These tests pin that each app's filter is the predicate
// actually handed to `expressIntegration` inside `Sentry.init`, not merely that
// the filter function exists.
const mockInit = jest.fn();
const mockExpressIntegration = jest.fn((options: unknown) => ({ name: 'Express', options }));

jest.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => mockInit(...args),
  expressIntegration: (options: unknown) => mockExpressIntegration(options),
}));
// Keeps the developer's local .env out of the test's process.env.
jest.mock('dotenv/config', () => ({}));

type ShouldHandleError = (error: Error) => boolean;

// `LmlClientError` is loaded in the same isolated registry as the instrument
// module, so the filter's `instanceof LmlClientError` sees the test's class.
function registeredFilter(relPath: string): { shouldHandleError: ShouldHandleError; LmlClientError: typeof Error } {
  let LmlClientError!: typeof Error;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(relPath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    LmlClientError = require('@wxyc/lml-client').LmlClientError;
  });
  const initOptions = mockInit.mock.calls[0][0] as { integrations: Array<{ name: string }> };
  expect(initOptions.integrations).toHaveLength(1);
  expect(initOptions.integrations[0].name).toBe('Express');
  const expressOptions = mockExpressIntegration.mock.calls[0][0] as { shouldHandleError: ShouldHandleError };
  return { shouldHandleError: expressOptions.shouldHandleError, LmlClientError };
}

describe('Express error filter registration on expressIntegration', () => {
  it('backend registers shouldCaptureExpressError: LmlClientError skipped, foreign 401 without expose captured', () => {
    const { shouldHandleError, LmlClientError } = registeredFilter('../../../apps/backend/instrument');
    expect(shouldHandleError(new (LmlClientError as new (m: string, s: number) => Error)('LML 502', 502))).toBe(false);
    expect(shouldHandleError(Object.assign(new Error('groq auth'), { status: 401 }))).toBe(true);
  });

  it('auth registers shouldCaptureAuthExpressError: sub-500 status skipped, 5xx captured', () => {
    const { shouldHandleError } = registeredFilter('../../../apps/auth/instrument');
    expect(shouldHandleError(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(false);
    expect(shouldHandleError(Object.assign(new Error('boom'), { statusCode: 500 }))).toBe(true);
  });

  it.each([
    ['backend', '../../../apps/backend/app.ts'],
    ['auth', '../../../apps/auth/app.ts'],
  ])('%s app.ts no longer calls the deprecated setupExpressErrorHandler', (_app, relPath) => {
    const source = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(source).not.toMatch(/Sentry\.setupExpressErrorHandler\(/);
  });
});

// v11 defaults to `traceLifecycle: 'stream'`, which silently ignores
// `beforeSendTransaction` and `ignoreTransactions`. Both preloads pass
// `filterSentryTransactionEvent` as `beforeSendTransaction` (BS#2089), so they
// must stay on the static lifecycle or the liveness probes and Express
// middleware spans that filter drops are sent again.
describe('transaction filter stays active under Sentry 11', () => {
  it.each([
    ['backend', '../../../apps/backend/instrument'],
    ['auth', '../../../apps/auth/instrument'],
  ])('%s pins traceLifecycle to static alongside beforeSendTransaction', (_app, relPath) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(relPath);
    });
    const initOptions = mockInit.mock.calls.at(-1)?.[0] as { beforeSendTransaction?: unknown; traceLifecycle?: string };
    expect(initOptions.beforeSendTransaction).toEqual(expect.any(Function));
    expect(initOptions.traceLifecycle).toBe('static');
  });
});
