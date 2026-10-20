import { PostHog } from 'posthog-node';
import { PostHogReporter, installCrashHandlers } from '@wxyc/observability/posthog';
import { heldPromise, expectPending } from '../../utils/held-promise';

const mockClient = { captureException: jest.fn(), capture: jest.fn(), flush: jest.fn() };
jest.mock('posthog-node', () => ({ PostHog: jest.fn(() => mockClient) }));

const PostHogMock = jest.mocked(PostHog);

type Handler = (...args: unknown[]) => void;

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('installCrashHandlers (BS#3517)', () => {
  const originalKey = process.env.POSTHOG_ERRORS_API_KEY;
  let exit: jest.SpyInstance;
  let on: jest.SpyInstance;
  let off: jest.SpyInstance;
  /** The listeners registered through the spied `process.on`; nothing is attached to the real process. */
  let handlers: Record<string, Handler>;

  const build = () =>
    new PostHogReporter({ service: 'backend', environment: 'production', budget: { kind: 'daily', ceiling: 300 } });

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};
    process.env.POSTHOG_ERRORS_API_KEY = 'phc_test';
    mockClient.flush.mockResolvedValue(undefined);
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    on = jest.spyOn(process, 'on').mockImplementation(((event: string, fn: Handler) => {
      handlers[event] = fn;
      return process;
    }) as never);
    off = jest.spyOn(process, 'off').mockImplementation((() => process) as never);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalKey === undefined) {
      delete process.env.POSTHOG_ERRORS_API_KEY;
    } else {
      process.env.POSTHOG_ERRORS_API_KEY = originalKey;
    }
  });

  it('reports one crash event for an uncaught exception, then exits 1', async () => {
    installCrashHandlers(build());
    const err = new Error('kaboom');
    handlers['uncaughtException'](err);
    await settle();
    expect(mockClient.captureException).toHaveBeenCalledTimes(1);
    const [sent, distinctId, properties] = mockClient.captureException.mock.calls[0];
    expect(sent).toBe(err);
    expect(distinctId).toBe('backend');
    expect(properties['$wxyc_crash_mechanism']).toBe('onuncaughtexception');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('waits for the PostHog flush and the extra beforeExit work before it exits', async () => {
    const flush = heldPromise<void>();
    mockClient.flush.mockImplementation(flush.hold);
    const closeOther = heldPromise<boolean>();
    const exited = new Promise<void>((resolve) => {
      exit.mockImplementation((() => resolve()) as never);
    });
    installCrashHandlers(build(), closeOther.hold);
    handlers['uncaughtException'](new Error('kaboom'));
    await expectPending(exited);
    flush.release();
    await expectPending(exited);
    closeOther.release(true);
    await exited;
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits once even when a second exception arrives while flushing', async () => {
    installCrashHandlers(build());
    handlers['uncaughtException'](new Error('first'));
    handlers['uncaughtException'](new Error('second'));
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('reports an unhandled rejection the same way, flushes, and leaves the exit to the process', async () => {
    installCrashHandlers(build());
    handlers['unhandledRejection'](new Error('rejected'), Promise.resolve());
    await settle();
    expect(mockClient.captureException).toHaveBeenCalledTimes(1);
    expect(mockClient.captureException.mock.calls[0][2]['$wxyc_crash_mechanism']).toBe('onunhandledrejection');
    expect(mockClient.flush).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not send a crash for an exception a call site already captured', async () => {
    const reporter = build();
    installCrashHandlers(reporter);
    const err = new Error('captured then rethrown');
    reporter.captureException(err, { fingerprint: ['somewhere', 'else'] });
    handlers['uncaughtException'](err);
    await settle();
    expect(mockClient.captureException).toHaveBeenCalledTimes(1);
    expect(mockClient.captureException.mock.calls[0][2]).not.toHaveProperty('$wxyc_crash_mechanism');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('spends the same token bucket as handled events, and still exits when the bucket is empty', async () => {
    const reporter = build();
    installCrashHandlers(reporter);
    // A daily budget starts with 20 tokens; drain them with distinct handled errors.
    for (let i = 0; i < 20; i++) {
      reporter.captureException(new Error(`handled ${i}`));
    }
    expect(mockClient.captureException).toHaveBeenCalledTimes(20);
    handlers['uncaughtException'](new Error('crash with no token left'));
    await settle();
    expect(mockClient.captureException).toHaveBeenCalledTimes(20);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('installs nothing without POSTHOG_ERRORS_API_KEY', () => {
    delete process.env.POSTHOG_ERRORS_API_KEY;
    const uninstall = installCrashHandlers(build());
    expect(PostHogMock).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    uninstall();
    expect(off).not.toHaveBeenCalled();
  });

  it('removes both listeners when the returned function is called', () => {
    const uninstall = installCrashHandlers(build());
    expect(on).toHaveBeenCalledTimes(2);
    uninstall();
    expect(off).toHaveBeenCalledWith('uncaughtException', handlers['uncaughtException']);
    expect(off).toHaveBeenCalledWith('unhandledRejection', handlers['unhandledRejection']);
  });
});
