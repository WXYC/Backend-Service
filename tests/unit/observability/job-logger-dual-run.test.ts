import { PostHog } from 'posthog-node';
import { createJobLogger } from '@wxyc/observability/job-logger';
import { getErrorReporter } from '@wxyc/observability';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setTag: jest.fn(),
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

/** Properties of every PostHog event sent so far, in order. */
const sentProperties = (): Array<Record<string, unknown>> => [
  ...mockClient.captureException.mock.calls.map((c) => c[2]),
  ...mockClient.capture.mock.calls.map((c) => c[0].properties),
];

describe('createJobLogger dual-run to PostHog (BS#3409)', () => {
  const saved = {
    key: process.env.POSTHOG_ERRORS_API_KEY,
    release: process.env.SENTRY_RELEASE,
    nodeEnv: process.env.NODE_ENV,
  };
  let spies: jest.SpyInstance[];
  let log: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.flush.mockResolvedValue(undefined);
    process.env.POSTHOG_ERRORS_API_KEY = 'phc_test';
    delete process.env.SENTRY_RELEASE;
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    spies = [
      log,
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    for (const [name, value] of [
      ['POSTHOG_ERRORS_API_KEY', saved.key],
      ['SENTRY_RELEASE', saved.release],
      ['NODE_ENV', saved.nodeEnv],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('constructs no PostHog client without POSTHOG_ERRORS_API_KEY, and Sentry stays the only sink', () => {
    delete process.env.POSTHOG_ERRORS_API_KEY;
    const { initLogger, captureError } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'r', tool: 't' });
    captureError(new Error('boom'), 'step');
    expect(PostHogMock).not.toHaveBeenCalled();
  });

  it('registers the composite, so a capture through the holder reaches PostHog', () => {
    const { reporter, initLogger } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'r', tool: 't' });
    expect(getErrorReporter()).toBe(reporter);
    getErrorReporter().captureMessage('from a shared library');
    expect(sentProperties()).toHaveLength(1);
  });

  it('sends service, repo, tool and run_id on every PostHog event', () => {
    const { initLogger, captureError, captureWarning } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'Backend-Service', tool: 'demo', runId: 'run-9' });
    captureError(new Error('one'), 'step-a');
    captureWarning('two', 'step-b');
    expect(sentProperties()).toHaveLength(2);
    for (const properties of sentProperties()) {
      expect(properties).toMatchObject({ service: 'demo-job', repo: 'Backend-Service', tool: 'demo', run_id: 'run-9' });
    }
  });

  it.each([
    ['the default budget of 10', undefined, 'demo-job', 10],
    ['an errorBudget of 2', 2, 'legacy-linkage-resolve', 2],
  ])('drops the event after %s', (_name, errorBudget, jobName, admitted) => {
    const { initLogger, captureError } = createJobLogger({ jobName, ...(errorBudget && { errorBudget }) });
    initLogger({ repo: 'r', tool: 't' });
    for (let i = 1; i <= admitted + 1; i++) {
      captureError(new Error(`distinct failure ${i}`), 'step');
    }
    expect(sentProperties()).toHaveLength(admitted);
  });

  it.each([
    ['carries release when SENTRY_RELEASE is set', 'demo-job@v1.2.3', { release: 'demo-job@v1.2.3' }],
    ['carries no release when it is unset', undefined, null],
  ])('%s', (_name, release, expected) => {
    if (release !== undefined) {
      process.env.SENTRY_RELEASE = release;
    }
    const { initLogger, captureError } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'r', tool: 't' });
    captureError(new Error('boom'), 'step');
    const [properties] = sentProperties();
    if (expected) {
      expect(properties).toMatchObject(expected);
    } else {
      expect(properties).not.toHaveProperty('release');
    }
  });

  it('maps NODE_ENV to the PostHog environment', () => {
    process.env.NODE_ENV = 'staging';
    const { initLogger, captureError } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'r', tool: 't' });
    captureError(new Error('boom'), 'step');
    expect(sentProperties()[0]).toMatchObject({ environment: 'staging' });
  });

  it('writes one job counter as exactly one log line, with nothing sent to PostHog', () => {
    const { initLogger, captureCounter } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'r', tool: 't', runId: 'run-1' });
    captureCounter('rows_processed', 5, { step: 'x' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ metric: 'rows_processed', value: 5, run_id: 'run-1' });
    expect(sentProperties()).toHaveLength(0);
  });

  it('closeLogger flushes PostHog as well', async () => {
    const { initLogger, closeLogger } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'r', tool: 't' });
    await closeLogger();
    expect(mockClient.flush).toHaveBeenCalled();
  });
});
