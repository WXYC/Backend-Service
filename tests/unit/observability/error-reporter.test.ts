import * as Sentry from '@sentry/node';
import { CompositeReporter, logCounter } from '@wxyc/observability';
import type { ErrorReporter } from '@wxyc/observability';
import { SentryReporter } from '@wxyc/observability/sentry';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  getCurrentScope: jest.fn(),
  flush: jest.fn(),
}));

const sentry = jest.mocked(Sentry);

describe('SentryReporter', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it('passes an exception and its level, tags, extra and fingerprint to captureException', () => {
    const err = new Error('boom');
    const context = {
      level: 'warning' as const,
      tags: { subsystem: 'metadata' },
      extra: { show_id: 4 },
      fingerprint: ['a', 'b'],
    };
    new SentryReporter().captureException(err, context);
    expect(sentry.captureException).toHaveBeenCalledWith(err, context);
  });

  it('passes a message and its context to captureMessage', () => {
    const context = { level: 'warning' as const, tags: { tool: 'flowsheet' }, extra: { album_id: 1 } };
    new SentryReporter().captureMessage('degrading', context);
    expect(sentry.captureMessage).toHaveBeenCalledWith('degrading', context);
  });

  it('passes a breadcrumb through unchanged', () => {
    const crumb = { category: 'library.refile', level: 'warning' as const, message: 'stood down', data: { id: 1 } };
    new SentryReporter().addBreadcrumb(crumb);
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(crumb);
  });

  it('sets a request tag on the current scope', () => {
    const setTag = jest.fn();
    sentry.getCurrentScope.mockReturnValue({ setTag } as never);
    new SentryReporter().setRequestTag('request_id', 'abc');
    expect(setTag).toHaveBeenCalledWith('request_id', 'abc');
  });

  it('flushes with the timeout and returns the result', async () => {
    sentry.flush.mockResolvedValue(true);
    await expect(new SentryReporter().flush(500)).resolves.toBe(true);
    expect(sentry.flush).toHaveBeenCalledWith(500);
  });

  it('writes counters as a log line and never calls Sentry metrics', () => {
    new SentryReporter().recordCounter('lml.resolve.fallback_to_null', 1, { caller: 'add_to_rotation' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      metric: 'lml.resolve.fallback_to_null',
      value: 1,
      caller: 'add_to_rotation',
    });
  });
});

describe('logCounter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lets metric and value win over same-named fields', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    logCounter('n', 2, { metric: 'x', value: 9 });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ metric: 'n', value: 2 });
  });

  it('never throws, even when the line cannot be written', () => {
    jest.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('stdout closed');
    });
    expect(() => logCounter('n', 1)).not.toThrow();
  });

  it('never throws on unserialisable fields', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const fields = {
      get bad(): string {
        throw new Error('getter');
      },
    };
    expect(() => logCounter('n', 1, fields)).not.toThrow();
  });
});

describe('CompositeReporter', () => {
  const fake = (): jest.Mocked<ErrorReporter> => ({
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
    setRequestTag: jest.fn(),
    recordCounter: jest.fn(),
    flush: jest.fn().mockResolvedValue(true),
  });

  it('fans every call out to every reporter, and keeps going when one throws', () => {
    const [a, b] = [fake(), fake()];
    a.captureException.mockImplementation(() => {
      throw new Error('a down');
    });
    const composite = new CompositeReporter([a, b]);
    const err = new Error('x');
    composite.captureException(err, { tags: { t: '1' } });
    composite.captureMessage('m');
    composite.addBreadcrumb({ message: 'c' });
    composite.setRequestTag('k', 'v');
    composite.recordCounter('n', 1, { f: 'x' });
    for (const r of [a, b]) {
      expect(r.captureException).toHaveBeenCalledWith(err, { tags: { t: '1' } });
      expect(r.captureMessage).toHaveBeenCalledWith('m', undefined);
      expect(r.addBreadcrumb).toHaveBeenCalledWith({ message: 'c' });
      expect(r.setRequestTag).toHaveBeenCalledWith('k', 'v');
      expect(r.recordCounter).toHaveBeenCalledWith('n', 1, { f: 'x' });
    }
  });

  it('flush resolves false if any reporter times out or rejects', async () => {
    const [a, b] = [fake(), fake()];
    b.flush.mockRejectedValue(new Error('down'));
    await expect(new CompositeReporter([a, b]).flush(100)).resolves.toBe(false);
    await expect(new CompositeReporter([a]).flush(100)).resolves.toBe(true);
  });
});
