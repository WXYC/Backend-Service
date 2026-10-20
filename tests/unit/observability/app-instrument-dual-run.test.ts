import { PostHog } from 'posthog-node';
import { getErrorReporter, getExpressErrorReporter } from '@wxyc/observability';

jest.mock('dotenv/config', () => ({}));
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  expressIntegration: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  getCurrentScope: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  close: jest.fn().mockResolvedValue(true),
}));
const mockClient = { captureException: jest.fn(), capture: jest.fn(), flush: jest.fn() };
jest.mock('posthog-node', () => ({ PostHog: jest.fn(() => mockClient) }));

const PostHogMock = jest.mocked(PostHog);

const sentProperties = (): Array<Record<string, unknown>> => [
  ...mockClient.captureException.mock.calls.map((c) => c[2]),
  ...mockClient.capture.mock.calls.map((c) => c[0].properties),
];

/** Loads an app's preload as node does, once, in a fresh module registry. */
const loadInstrument = (path: string): void => {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(path);
  });
};

describe('app instrument.ts dual-run wiring (BS#3409)', () => {
  const names = ['POSTHOG_ERRORS_API_KEY', 'SENTRY_RELEASE', 'NODE_ENV'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  let warn: jest.SpyInstance;
  /** `process.on` is spied so loading a preload registers no crash handler on the test process. */
  let processOn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processOn = jest.spyOn(process, 'on').mockImplementation((() => process) as never);
    // The Express slot is process-wide and survives across tests; an app that never sets it must read the default.
    Reflect.deleteProperty(globalThis, Symbol.for('@wxyc/observability/express-error-reporter'));
    process.env.POSTHOG_ERRORS_API_KEY = 'phc_test';
    delete process.env.SENTRY_RELEASE;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    processOn.mockRestore();
    for (const name of names) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  describe.each([
    ['backend', '../../../apps/backend/instrument', true, 300],
    ['auth', '../../../apps/auth/instrument', true, 100],
    ['enrichment-worker', '../../../apps/enrichment-worker/instrument', false, 100],
  ])('%s', (service, path, hasExpress, dailyCeiling) => {
    it('registers a reporter that sends service, environment and release to PostHog', () => {
      process.env.SENTRY_RELEASE = `${service}@v1`;
      process.env.NODE_ENV = 'production';
      loadInstrument(path);
      getErrorReporter().captureMessage('hello');
      expect(sentProperties()).toEqual([
        expect.objectContaining({ service, environment: 'production', release: `${service}@v1` }),
      ]);
    });

    it('sends no release when SENTRY_RELEASE is unset', () => {
      loadInstrument(path);
      getErrorReporter().captureMessage('hello');
      expect(sentProperties()[0]).not.toHaveProperty('release');
    });

    it('drops the 21st distinct event: a bucket of 20 that refills slowly', () => {
      loadInstrument(path);
      for (let i = 1; i <= 21; i++) {
        getErrorReporter().captureMessage(`distinct ${i}`);
      }
      expect(sentProperties()).toHaveLength(20);
    });

    it(`refills at its daily ceiling of ${dailyCeiling} a day`, () => {
      const start = Date.now();
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        loadInstrument(path);
        for (let i = 1; i <= 20; i++) {
          getErrorReporter().captureMessage(`drain ${i}`);
        }
        mockClient.capture.mockClear();
        mockClient.captureException.mockClear();
        now.mockReturnValue(start + 3_600_000);
        for (let i = 1; i <= 30; i++) {
          getErrorReporter().captureMessage(`after an hour ${i}`);
        }
        expect(sentProperties()).toHaveLength(Math.floor(dailyCeiling / 24));
      } finally {
        now.mockRestore();
      }
    });

    it('constructs no PostHog client without POSTHOG_ERRORS_API_KEY', () => {
      delete process.env.POSTHOG_ERRORS_API_KEY;
      loadInstrument(path);
      getErrorReporter().captureMessage('hello');
      expect(PostHogMock).not.toHaveBeenCalled();
    });

    it.each([
      ['with', 'phc_test', ['uncaughtException', 'unhandledRejection']],
      ['without', undefined, []],
    ])('%s POSTHOG_ERRORS_API_KEY installs the PostHog crash handlers: %j', (_label, key, installed) => {
      if (key === undefined) {
        delete process.env.POSTHOG_ERRORS_API_KEY;
      }
      loadInstrument(path);
      expect(processOn.mock.calls.map((c) => c[0])).toEqual(installed);
    });

    it(`${hasExpress ? 'shares' : 'does not register'} its PostHog reporter for the Express error middleware`, () => {
      loadInstrument(path);
      getExpressErrorReporter().captureMessage('from express');
      expect(sentProperties()).toHaveLength(hasExpress ? 1 : 0);
    });
  });
});
