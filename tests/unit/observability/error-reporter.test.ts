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
    for (const r of [a, b]) {
      expect(r.captureException).toHaveBeenCalledWith(err, { tags: { t: '1' } });
      expect(r.captureMessage).toHaveBeenCalledWith('m', undefined);
      expect(r.addBreadcrumb).toHaveBeenCalledWith({ message: 'c' });
      expect(r.setRequestTag).toHaveBeenCalledWith('k', 'v');
    }
  });

  it('writes no counter line: counters do not go through reporters', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const composite = new CompositeReporter([fake(), fake()]);
    composite.captureException(new Error('x'));
    composite.captureMessage('m');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    ['captureException', (c: ErrorReporter) => c.captureException(new Error('x'))],
    ['captureMessage', (c: ErrorReporter) => c.captureMessage('m')],
    ['addBreadcrumb', (c: ErrorReporter) => c.addBreadcrumb({ message: 'c' })],
    ['setRequestTag', (c: ErrorReporter) => c.setRequestTag('k', 'v')],
  ] as const)('%s reaches the later reporters when an earlier one throws', (method, call) => {
    const [a, b] = [fake(), fake()];
    a[method].mockImplementation(() => {
      throw new Error('a down');
    });
    expect(() => call(new CompositeReporter([a, b]))).not.toThrow();
    expect(b[method]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rejects', (r: jest.Mocked<ErrorReporter>) => r.flush.mockRejectedValue(new Error('down'))],
    ['resolves false', (r: jest.Mocked<ErrorReporter>) => r.flush.mockResolvedValue(false)],
    [
      'throws synchronously',
      (r: jest.Mocked<ErrorReporter>) =>
        r.flush.mockImplementation(() => {
          throw new Error('sync');
        }),
    ],
  ] as const)('flush resolves false, and still flushes the others, when a reporter %s', async (_case, breakIt) => {
    const [a, b, c] = [fake(), fake(), fake()];
    breakIt(b);
    await expect(new CompositeReporter([a, b, c]).flush(100)).resolves.toBe(false);
    for (const r of [a, b, c]) {
      expect(r.flush).toHaveBeenCalledWith(100);
    }
  });

  it('flush resolves true when every reporter delivers', async () => {
    await expect(new CompositeReporter([fake(), fake()]).flush(100)).resolves.toBe(true);
  });

  it('flushes the reporters in parallel, not one after another', async () => {
    const [a, b] = [fake(), fake()];
    a.flush.mockReturnValue(new Promise<boolean>(() => undefined));
    void new CompositeReporter([a, b]).flush(100);
    await new Promise((resolve) => setImmediate(resolve));
    expect(b.flush).toHaveBeenCalledWith(100);
  });
  describe('runInScope', () => {
    const scoped = (order: string[], name: string): jest.Mocked<ErrorReporter> => {
      const r = fake();
      r.runInScope = jest.fn(<T>(fn: () => T): T => {
        order.push(`enter ${name}`);
        const out = fn();
        order.push(`exit ${name}`);
        return out;
      }) as jest.Mocked<ErrorReporter>['runInScope'];
      return r;
    };

    it('nests the call through each child that implements it and returns the result', () => {
      const order: string[] = [];
      const composite = new CompositeReporter([scoped(order, 'a'), fake(), scoped(order, 'b')]);
      const result = composite.runInScope(() => {
        order.push('fn');
        return 42;
      });
      expect(result).toBe(42);
      expect(order).toEqual(['enter a', 'enter b', 'fn', 'exit b', 'exit a']);
    });

    it('just calls fn when no child implements it', () => {
      expect(new CompositeReporter([fake(), fake()]).runInScope(() => 'ran')).toBe('ran');
    });
  });
});
