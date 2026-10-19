import { PostHog } from 'posthog-node';
import { PostHogReporter } from '@wxyc/observability/posthog';
import type { PostHogReporterOptions } from '@wxyc/observability/posthog';

const mockClient = { captureException: jest.fn(), capture: jest.fn(), flush: jest.fn() };
jest.mock('posthog-node', () => ({ PostHog: jest.fn(() => mockClient) }));
const client = mockClient;

const PostHogMock = jest.mocked(PostHog);

const T0 = new Date('2026-10-19T12:00:00Z');

const build = (overrides: Partial<PostHogReporterOptions> = {}) =>
  new PostHogReporter({
    service: 'backend',
    environment: 'production',
    budget: { kind: 'daily', ceiling: 300 },
    ...overrides,
  });

const sentProperties = (): Record<string, unknown> => {
  if (client.captureException.mock.calls.length > 0) {
    return client.captureException.mock.calls[0][2];
  }
  return client.capture.mock.calls[0][0].properties;
};

describe('PostHogReporter', () => {
  const originalKey = process.env.POSTHOG_ERRORS_API_KEY;
  const originalHost = process.env.POSTHOG_HOST;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    jest.clearAllMocks();
    process.env.POSTHOG_ERRORS_API_KEY = 'phc_test';
    delete process.env.POSTHOG_HOST;
    client.flush.mockResolvedValue(undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
    process.env.POSTHOG_ERRORS_API_KEY = originalKey;
    process.env.POSTHOG_HOST = originalHost;
    if (originalKey === undefined) {
      delete process.env.POSTHOG_ERRORS_API_KEY;
    }
    if (originalHost === undefined) {
      delete process.env.POSTHOG_HOST;
    }
  });

  describe('client', () => {
    it('builds its own client from POSTHOG_ERRORS_API_KEY and POSTHOG_HOST', () => {
      process.env.POSTHOG_HOST = 'https://eu.i.posthog.com';
      build();
      expect(PostHogMock).toHaveBeenCalledWith(
        'phc_test',
        expect.objectContaining({ host: 'https://eu.i.posthog.com' })
      );
    });

    it('is a no-op without a key: nothing is built, nothing throws, flush resolves true', async () => {
      delete process.env.POSTHOG_ERRORS_API_KEY;
      const reporter = build();
      expect(() => {
        reporter.captureException(new Error('boom'));
        reporter.captureMessage('degrading');
        reporter.addBreadcrumb({ message: 'x' });
        reporter.setRequestTag('request_id', 'r1');
      }).not.toThrow();
      expect(PostHogMock).not.toHaveBeenCalled();
      expect(client.captureException).not.toHaveBeenCalled();
      expect(client.capture).not.toHaveBeenCalled();
      await expect(reporter.flush(10)).resolves.toBe(true);
    });

    it('turns itself off when the client cannot be built', () => {
      PostHogMock.mockImplementationOnce(() => {
        throw new Error('bad config');
      });
      const reporter = build();
      expect(() => reporter.captureException(new Error('boom'))).not.toThrow();
      expect(client.captureException).not.toHaveBeenCalled();
    });

    it('swallows a send that throws', () => {
      client.captureException.mockImplementationOnce(() => {
        throw new Error('sdk down');
      });
      expect(() => build().captureException(new Error('boom'))).not.toThrow();
    });

    it('resolves flush false when the client does not drain in time', async () => {
      jest.useRealTimers();
      client.flush.mockReturnValue(new Promise(() => undefined));
      await expect(build().flush(10)).resolves.toBe(false);
    });

    it('resolves flush false when the client rejects', async () => {
      client.flush.mockRejectedValue(new Error('network'));
      await expect(build().flush(10)).resolves.toBe(false);
    });
  });

  describe('captureException payload', () => {
    it('sends the error with distinct_id = service and no person profile, leaving the level to the SDK', () => {
      const err = new Error('boom');
      build().captureException(err);
      const [sentErr, distinctId, properties] = client.captureException.mock.calls[0];
      expect(sentErr).toBe(err);
      expect(distinctId).toBe('backend');
      expect(properties).toEqual({ service: 'backend', environment: 'production', $process_person_profile: false });
      expect(properties).not.toHaveProperty('$exception_level');
    });

    it.each([
      ['warning', 'warning'],
      ['fatal', undefined],
      ['error', undefined],
      ['info', undefined],
    ] as const)('level %s sends $exception_level %s', (level, expected) => {
      build().captureException(new Error('boom'), { level });
      expect(sentProperties()['$exception_level']).toBe(expected);
    });

    it('joins the fingerprint parts with ":" into one string', () => {
      build().captureException(new Error('boom'), { fingerprint: ['job', 'mismatch', '123'] });
      expect(sentProperties()['$exception_fingerprint']).toBe('job:mismatch:123');
    });

    it('sends tags flat and extra nested, and tags cannot override the contract properties', () => {
      build().captureException(new Error('boom'), {
        tags: { subsystem: 'metadata', service: 'spoofed' },
        extra: { show_id: 4 },
      });
      expect(sentProperties()).toMatchObject({ subsystem: 'metadata', service: 'backend', extra: { show_id: 4 } });
    });
  });

  describe('captureMessage payload', () => {
    it('sends a synthesized $exception with one Message entry and the message as fingerprint', () => {
      build().captureMessage('rebuild failed: 3 tables missing');
      expect(client.capture).toHaveBeenCalledTimes(1);
      const event = client.capture.mock.calls[0][0];
      expect(event.event).toBe('$exception');
      expect(event.distinctId).toBe('backend');
      expect(event.properties).toEqual({
        service: 'backend',
        environment: 'production',
        $process_person_profile: false,
        $exception_list: [
          {
            type: 'Message',
            value: 'rebuild failed: 3 tables missing',
            mechanism: { type: 'generic', handled: true, synthetic: true },
          },
        ],
        $exception_types: ['Message'],
        $exception_fingerprint: 'rebuild failed: 3 tables missing',
        $exception_level: 'error',
      });
    });

    it.each([
      [undefined, 'error'],
      ['warning', 'warning'],
      ['info', 'error'],
      ['fatal', 'error'],
    ] as const)('level %s sends $exception_level %s', (level, expected) => {
      build().captureMessage('m', { level });
      expect(sentProperties()['$exception_level']).toBe(expected);
    });

    it('uses the caller fingerprint joined with ":" in place of the message', () => {
      build().captureMessage('m', { fingerprint: ['job', 'provenance'] });
      expect(sentProperties()['$exception_fingerprint']).toBe('job:provenance');
    });
  });

  describe('properties', () => {
    it.each([
      [undefined, 'production'],
      ['production', 'production'],
      ['staging', 'staging'],
      ['development', 'development'],
      ['test', 'production'],
      ['prod', 'production'],
    ])('maps environment %s to %s', (raw, expected) => {
      build({ environment: raw }).captureException(new Error('boom'));
      expect(sentProperties()['environment']).toBe(expected);
    });

    it('includes release when set', () => {
      build({ release: 'abc123' }).captureException(new Error('boom'));
      expect(sentProperties()['release']).toBe('abc123');
    });

    it.each([undefined, ''])('omits the release key when it is %j', (release) => {
      build({ release }).captureException(new Error('boom'));
      expect(sentProperties()).not.toHaveProperty('release');
    });

    it('adds the run-wide properties and the request tag, and the reporter fields win on a clash', () => {
      const reporter = build({
        properties: { repo: 'Backend-Service', tool: 'legacy-linkage-resolve', run_id: 'run-1', service: 'spoofed' },
      });
      reporter.setRequestTag('request_id', 'req-9');
      reporter.captureMessage('m');
      expect(sentProperties()).toMatchObject({
        repo: 'Backend-Service',
        tool: 'legacy-linkage-resolve',
        run_id: 'run-1',
        request_id: 'req-9',
        service: 'backend',
      });
    });
  });

  describe('breadcrumbs', () => {
    it('attaches the trail to an exception, keeping the last 50', () => {
      const reporter = build();
      for (let i = 0; i < 60; i += 1) {
        reporter.addBreadcrumb({ category: 'db', message: `step ${i}`, data: { i } });
      }
      reporter.captureException(new Error('boom'));
      const crumbs = sentProperties()['breadcrumbs'] as Array<{ message: string; timestamp: string }>;
      expect(crumbs).toHaveLength(50);
      expect(crumbs[0].message).toBe('step 10');
      expect(crumbs[49].message).toBe('step 59');
      expect(crumbs[0].timestamp).toBe(T0.toISOString());
    });

    it('sends no breadcrumbs property when the trail is empty', () => {
      build().captureException(new Error('boom'));
      expect(sentProperties()).not.toHaveProperty('breadcrumbs');
    });

    it('keeps each request scope separate', () => {
      const reporter = build();
      reporter.addBreadcrumb({ message: 'outside' });
      reporter.runInScope(() => {
        reporter.addBreadcrumb({ message: 'inside' });
        reporter.setRequestTag('request_id', 'req-1');
        reporter.captureException(new Error('boom'));
      });
      const props = sentProperties();
      expect((props['breadcrumbs'] as Array<{ message: string }>).map((c) => c.message)).toEqual(['inside']);
      expect(props['request_id']).toBe('req-1');

      client.captureException.mockClear();
      reporter.captureException(new Error('later'));
      expect(sentProperties()).not.toHaveProperty('request_id');
    });
  });

  describe('privacy', () => {
    it('sends a failed query error without its bound parameters', () => {
      const err = new Error('Failed query: select * from djs where real_name = $1\nparams: Jane Q Public');
      build().captureException(err);
      const sent = client.captureException.mock.calls[0][0] as Error;
      expect(sent.message).not.toContain('Jane Q Public');
    });
  });

  describe('error-storm backstop', () => {
    it('daily budget: bursts to 20, then refills at ceiling / 86,400 per second', () => {
      const reporter = build({ budget: { kind: 'daily', ceiling: 8640 } });
      for (let i = 0; i < 25; i += 1) {
        reporter.captureMessage(`distinct ${i}`);
      }
      expect(client.capture).toHaveBeenCalledTimes(20);

      jest.setSystemTime(T0.getTime() + 10_000);
      reporter.captureMessage('after refill a');
      reporter.captureMessage('after refill b');
      expect(client.capture).toHaveBeenCalledTimes(21);
    });

    it('daily budget: never refills past the capacity of 20', () => {
      const reporter = build({ budget: { kind: 'daily', ceiling: 8640 } });
      jest.setSystemTime(T0.getTime() + 24 * 3600 * 1000);
      for (let i = 0; i < 30; i += 1) {
        reporter.captureMessage(`distinct ${i}`);
      }
      expect(client.capture).toHaveBeenCalledTimes(20);
    });

    it('run budget: capacity is the ceiling and it never refills', () => {
      const reporter = build({ budget: { kind: 'run', ceiling: 2 } });
      for (let i = 0; i < 5; i += 1) {
        reporter.captureMessage(`distinct ${i}`);
      }
      expect(client.capture).toHaveBeenCalledTimes(2);

      jest.setSystemTime(T0.getTime() + 24 * 3600 * 1000);
      reporter.captureMessage('much later');
      expect(client.capture).toHaveBeenCalledTimes(2);
    });

    it('drops a repeat of the same fingerprint inside 60 s without spending a token, and admits it after', () => {
      const reporter = build({ budget: { kind: 'run', ceiling: 2 } });
      reporter.captureMessage('a');
      reporter.captureMessage('a');
      reporter.captureMessage('b');
      expect(client.capture).toHaveBeenCalledTimes(2);

      const spent = build({ budget: { kind: 'run', ceiling: 5 } });
      client.capture.mockClear();
      spent.captureMessage('a');
      jest.setSystemTime(T0.getTime() + 59_000);
      spent.captureMessage('a');
      expect(client.capture).toHaveBeenCalledTimes(1);
      jest.setSystemTime(T0.getTime() + 61_000);
      spent.captureMessage('a');
      expect(client.capture).toHaveBeenCalledTimes(2);
    });

    it('dedupes exceptions on the caller fingerprint, else on type and message', () => {
      const reporter = build();
      reporter.captureException(new Error('boom'), { fingerprint: ['f'] });
      reporter.captureException(new TypeError('different'), { fingerprint: ['f'] });
      reporter.captureException(new Error('boom'));
      reporter.captureException(new Error('boom'));
      expect(client.captureException).toHaveBeenCalledTimes(2);
    });

    it('logs dropped events at most once a minute', () => {
      const reporter = build({ budget: { kind: 'run', ceiling: 1 } });
      reporter.captureMessage('a');
      reporter.captureMessage('b');
      reporter.captureMessage('c');
      expect(warn).toHaveBeenCalledTimes(1);
      jest.setSystemTime(T0.getTime() + 61_000);
      reporter.captureMessage('d');
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  it('is not loaded by the barrel', () => {
    jest.isolateModules(() => {
      jest.doMock('posthog-node', () => {
        throw new Error('the barrel loaded posthog-node');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => require('@wxyc/observability')).not.toThrow();
    });
  });
});
