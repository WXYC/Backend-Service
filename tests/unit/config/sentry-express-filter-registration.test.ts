import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SENTRY_DATA_COLLECTION } from '@wxyc/observability';

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
// The enrichment worker still loads .env through a body-level `config()`.
jest.mock('dotenv', () => ({ config: jest.fn() }));

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

// Sentry 11 defaults `traceLifecycle` to 'stream', under which no transaction
// event is built and `beforeSendTransaction` never runs — so the BS#2089 /
// BS#2406 `filterSentryTransactionEvent` would be wired but dead (BS#2948).
// The enrichment worker has no transaction filter, so it is deliberately left
// on the default, like the jobs/* loggers.
describe('trace lifecycle', () => {
  it.each([
    ['backend', '../../../apps/backend/instrument'],
    ['auth', '../../../apps/auth/instrument'],
  ])('%s pins the static trace lifecycle', (_app, relPath) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(relPath);
    });
    const initOptions = mockInit.mock.calls[0][0] as { traceLifecycle?: string };
    expect(initOptions.traceLifecycle).toBe('static');
  });
});

// What each preload hands `Sentry.init`, not what its source text says: a
// commented-out or overridden `dataCollection` must fail here (BS#3004).
describe('data collection', () => {
  it.each([
    ['backend', '../../../apps/backend/instrument'],
    ['auth', '../../../apps/auth/instrument'],
    ['enrichment-worker', '../../../apps/enrichment-worker/instrument'],
  ])('%s passes SENTRY_DATA_COLLECTION to Sentry.init', (_app, relPath) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(relPath);
    });
    const initOptions = mockInit.mock.calls[0][0] as { dataCollection?: unknown };
    expect(initOptions.dataCollection).toEqual(SENTRY_DATA_COLLECTION);
  });
});

// A failed Drizzle query's message quotes every bound value, which since
// BS#3051 can be a staff member's legal name (BS#3054). Both Express servers
// write staff names, so both register the scrub on error events and breadcrumbs.
describe('failed-query parameter scrub', () => {
  const APPS = [
    ['backend', '../../../apps/backend/instrument'],
    ['auth', '../../../apps/auth/instrument'],
  ];

  type InitOptions = {
    beforeSend?: (event: unknown) => { exception?: { values?: Array<{ value?: string }> } } | null;
    beforeBreadcrumb?: (breadcrumb: unknown) => { message?: string; data?: { arguments?: unknown[] } } | null;
  };

  function initOptionsFor(relPath: string): InitOptions {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(relPath);
    });
    return mockInit.mock.calls[0][0] as InitOptions;
  }

  it.each(APPS)(
    '%s registers a beforeSend that redacts bound parameters and still reports the error',
    (_app, relPath) => {
      const event = {
        exception: { values: [{ type: 'DrizzleQueryError', value: 'Failed query: select 1\nparams: Test Reviewer' }] },
      };

      const sent = initOptionsFor(relPath).beforeSend?.(event);

      expect(sent).not.toBeNull();
      expect(sent?.exception?.values?.[0]).toEqual({
        type: 'DrizzleQueryError',
        value: 'Failed query: select 1\nparams: [redacted]',
      });
    }
  );

  it.each(APPS)(
    '%s registers a beforeBreadcrumb that redacts console arguments and keeps the breadcrumb',
    (_app, relPath) => {
      const error = new Error('Failed query: select 1\nparams: Test Reviewer');
      const breadcrumb = { category: 'console', message: error.message, data: { arguments: ['oops', error] } };

      const kept = initOptionsFor(relPath).beforeBreadcrumb?.(breadcrumb);

      expect(kept).not.toBeNull();
      expect(JSON.stringify(kept, Object.getOwnPropertyNames(error))).not.toContain('Test Reviewer');
      expect((kept?.data?.arguments?.[1] as Error).message).toBe('Failed query: select 1\nparams: [redacted]');
    }
  );

  // Sentry 11's Express channel puts `error.message` in the failing layer's span
  // status. Static trace lifecycle drops that message from the transaction JSON;
  // span streaming would send it as an attribute, bound parameters included.
  // Moving the filter to streaming (BS#2959) must scrub span statuses first.
  it.each(APPS)('%s pins traceLifecycle: static, which keeps span status messages out of Sentry', (_app, relPath) => {
    expect(initOptionsFor(relPath)).toMatchObject({ traceLifecycle: 'static' });
  });
});
