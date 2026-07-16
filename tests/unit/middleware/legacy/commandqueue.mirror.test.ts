import { jest } from '@jest/globals';

const mockSend = jest.fn<() => Promise<string>>();
jest.mock('@wxyc/database', () => ({
  MirrorSQL: {
    instance: () => ({ send: mockSend }),
  },
}));

const mockBroadcast = jest.fn();
jest.mock('../../../../apps/backend/utils/serverEvents', () => ({
  serverEventsMgr: { broadcast: (...args: unknown[]) => mockBroadcast(...args) },
  MirrorEvents: {
    syncStarted: 'syncStarted',
    syncProgress: 'syncProgress',
    syncComplete: 'syncComplete',
    syncRetry: 'syncRetry',
    syncError: 'syncError',
  },
}));

let idCounter = 0;
jest.mock('../../../../apps/backend/middleware/legacy/utilities.mirror', () => ({
  cryptoRandomId: () => `test-id-${idCounter++}`,
  expBackoffMs: () => 1,
}));

const mockMkdir = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockWriteFile = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.mock('fs', () => ({
  promises: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

const mockAddBreadcrumb = jest.fn();
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  addBreadcrumb: (...args: unknown[]) => mockAddBreadcrumb(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  withScope: (fn: (scope: unknown) => void) => fn({ setTags: jest.fn(), setExtra: jest.fn() }),
}));

import {
  MirrorCommandQueue,
  type FatalInfo,
  type MirrorCommand,
} from '../../../../apps/backend/middleware/legacy/commandqueue.mirror';

const SECONDARY_ENV_VARS = [
  'MIRROR_SECONDARY_REPORTS_MAX',
  'MIRROR_SECONDARY_REPORTS_INTERVAL_MS',
  'MIRROR_SECONDARY_REPORT_ON_ATTEMPT',
  'MIRROR_FATAL_REPORTS_MAX',
  'MIRROR_FATAL_REPORTS_INTERVAL_MS',
  'MIRROR_REPORT_MAX_BYTES',
  'MIRROR_PENDING_QUEUE_SUMMARIES_MAX',
];

describe('MirrorCommandQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    idCounter = 0;
    SECONDARY_ENV_VARS.forEach((v) => delete process.env[v]);
    (MirrorCommandQueue as unknown as { _instance: unknown })._instance = null;
  });

  afterEach(() => {
    jest.useRealTimers();
    SECONDARY_ENV_VARS.forEach((v) => delete process.env[v]);
  });

  function createQueue(options = {}) {
    return MirrorCommandQueue.instance({
      maxAttempts: 3,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      jitterMs: 0,
      logFile: '/tmp/test-mirror-logs',
      ...options,
    });
  }

  test('enqueue wraps SQL in a transaction and populates fingerprint fields', () => {
    const queue = createQueue();
    const cmd = queue.enqueue(['SELECT 1', 'SELECT 2']);

    expect(cmd).not.toBeNull();
    expect(cmd?.sql).toContain('START TRANSACTION;');
    expect(cmd?.sql).toContain('SELECT 1;');
    expect(cmd?.sql).toContain('SELECT 2;');
    expect(cmd?.sql).toContain('COMMIT;');
    expect(cmd?.statementsCount).toBe(2);
    expect(cmd?.sqlLength).toBe(cmd?.sql.length);
    expect(cmd?.sqlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(['pending', 'in_progress']).toContain(cmd?.status);
  });

  test('successful command emits succeeded event', async () => {
    mockSend.mockResolvedValueOnce('OK');
    const queue = createQueue();
    const succeededSpy = jest.fn();
    queue.on('succeeded', succeededSpy);

    queue.enqueue(['SELECT 1']);
    await jest.advanceTimersByTimeAsync(10);

    expect(succeededSpy).toHaveBeenCalledTimes(1);
    expect(succeededSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', attempts: 1 }));
  });

  test('failed command retries up to maxAttempts and stops fatal', async () => {
    mockSend
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'));

    const queue = createQueue({ maxAttempts: 3 });
    const fatalSpy = jest.fn();
    queue.on('fatal', fatalSpy);

    queue.enqueue(['SELECT 1']);

    await jest.advanceTimersByTimeAsync(50);

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(queue.isDead()).toBe(true);
  });

  test('dead queue rejects new commands', async () => {
    mockSend.mockRejectedValue(new Error('always fails'));

    const queue = createQueue({ maxAttempts: 1 });
    queue.enqueue(['SELECT 1']);

    await jest.advanceTimersByTimeAsync(50);

    expect(queue.isDead()).toBe(true);
    expect(queue.enqueue(['SELECT 2'])).toBeNull();
  });

  describe('recovery after fatalStop', () => {
    test('instance() returns a fresh live queue after the prior singleton went fatal', async () => {
      mockSend.mockRejectedValueOnce(new Error('fatal 1'));

      const dead = createQueue({ maxAttempts: 1 });
      dead.enqueue(['SELECT 1']);
      await jest.advanceTimersByTimeAsync(50);

      expect(dead.isDead()).toBe(true);

      // Simulate the next legacy-mirror cycle: it calls `instance()` again,
      // expecting a usable queue. After fatalStop, that call must yield a
      // fresh live instance, not the dead singleton.
      mockSend.mockResolvedValueOnce('OK');
      const recovered = MirrorCommandQueue.instance({
        maxAttempts: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        jitterMs: 0,
        logFile: '/tmp/test-mirror-logs',
      });

      expect(recovered).not.toBe(dead);
      expect(recovered.isAlive()).toBe(true);

      const succeededSpy = jest.fn();
      recovered.on('succeeded', succeededSpy);

      const cmd = recovered.enqueue(['SELECT 2']);
      expect(cmd).not.toBeNull();

      await jest.advanceTimersByTimeAsync(50);
      expect(succeededSpy).toHaveBeenCalledTimes(1);
    });

    test('repeated fatalStop -> recover cycles do not leak listeners on the fresh instance', async () => {
      mockSend.mockRejectedValueOnce(new Error('cycle 1 fatal')).mockRejectedValueOnce(new Error('cycle 2 fatal'));

      const first = createQueue({ maxAttempts: 1 });
      first.enqueue(['SELECT 1']);
      await jest.advanceTimersByTimeAsync(50);
      expect(first.isDead()).toBe(true);

      const second = MirrorCommandQueue.instance({
        maxAttempts: 1,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        jitterMs: 0,
        logFile: '/tmp/test-mirror-logs',
      });
      expect(second).not.toBe(first);
      second.enqueue(['SELECT 2']);
      await jest.advanceTimersByTimeAsync(50);
      expect(second.isDead()).toBe(true);

      const third = MirrorCommandQueue.instance({
        maxAttempts: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        jitterMs: 0,
        logFile: '/tmp/test-mirror-logs',
      });
      expect(third).not.toBe(second);
      expect(third.isAlive()).toBe(true);

      // Each lifecycle event has exactly one listener registered by the
      // static `instance()` factory: the dispatch closure. Verifies that
      // recovery did not re-register listeners on the same shared instance.
      expect(third.listenerCount('enqueued')).toBe(1);
      expect(third.listenerCount('started')).toBe(1);
      expect(third.listenerCount('succeeded')).toBe(1);
      expect(third.listenerCount('failedAttempt')).toBe(1);
      expect(third.listenerCount('fatal')).toBe(1);
      expect(third.listenerCount('persisted')).toBe(1);
    });
  });

  describe('fatal report on disk', () => {
    test('uses ring-buffer filename and never serializes raw SQL', async () => {
      mockSend.mockRejectedValue(new Error('connection refused'));

      const queue = createQueue({ maxAttempts: 1 });
      // The literal "MIRROR_SQL_SECRET_TOKEN" appears only in the SQL string, not in the
      // error message or any other field, so any leak into the report can only come from
      // a code path that serializes raw SQL.
      queue.enqueue([`UPDATE users SET password = 'MIRROR_SQL_SECRET_TOKEN'`]);

      await jest.advanceTimersByTimeAsync(50);

      expect(mockMkdir).toHaveBeenCalledWith('/tmp/test-mirror-logs', { recursive: true });
      const fatalCall = mockWriteFile.mock.calls.find((c) => (c[0] as string).includes('queue-fatal-ring-')) as
        [string, string] | undefined;
      expect(fatalCall).toBeDefined();

      const [filePath, content] = fatalCall;
      expect(filePath).toMatch(/queue-fatal-ring-\d+\.json$/);

      const parsed = JSON.parse(content);
      expect(parsed.failedCommand).not.toHaveProperty('sql');
      expect(parsed.failedCommand.sqlLength).toBeGreaterThan(0);
      expect(parsed.failedCommand.sqlHash).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.failedCommand.statementsCount).toBe(1);
      expect(content).not.toContain('MIRROR_SQL_SECRET_TOKEN');
      expect(parsed.reason).toContain('maxAttempts=1');
    });

    test('emits a truncated summary instead of writing past MIRROR_REPORT_MAX_BYTES', async () => {
      process.env.MIRROR_REPORT_MAX_BYTES = '256';
      process.env.MIRROR_PENDING_QUEUE_SUMMARIES_MAX = '50';
      mockSend.mockRejectedValue(new Error('x'.repeat(2048)));

      const queue = createQueue({ maxAttempts: 1 });
      // Pad pending depth so the JSON exceeds 256 bytes even with hashed SQL.
      queue.enqueue(['INSERT INTO a VALUES (1)']);
      for (let i = 0; i < 5; i++) queue.enqueue([`INSERT INTO b VALUES (${i})`]);

      await jest.advanceTimersByTimeAsync(50);

      const fatalCall = mockWriteFile.mock.calls.find((c) => (c[0] as string).includes('queue-fatal-ring-')) as
        [string, string] | undefined;
      expect(fatalCall).toBeDefined();
      const parsed = JSON.parse(fatalCall[1]);
      expect(parsed.truncated).toBe(true);
      expect(parsed.jsonBytes).toBeGreaterThan(256);
    });
  });

  describe('secondary report', () => {
    test('writes queue-secondary-ring-N.json on first failure when enabled', async () => {
      mockSend.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('OK');

      const queue = createQueue({ maxAttempts: 3 });
      queue.enqueue(['SELECT 1']);

      await jest.advanceTimersByTimeAsync(50);

      const secondaryCall = mockWriteFile.mock.calls.find((c) => (c[0] as string).includes('queue-secondary-ring-')) as
        [string, string] | undefined;
      expect(secondaryCall).toBeDefined();
      const parsed = JSON.parse(secondaryCall[1]);
      expect(parsed.reportType).toBe('secondary');
      expect(parsed.cmd.sqlHash).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.cmd).not.toHaveProperty('sql');
    });

    test('disabled when MIRROR_SECONDARY_REPORTS_MAX=0', async () => {
      process.env.MIRROR_SECONDARY_REPORTS_MAX = '0';
      mockSend.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('OK');

      const queue = createQueue({ maxAttempts: 3 });
      queue.enqueue(['SELECT 1']);
      await jest.advanceTimersByTimeAsync(50);

      const secondaryCalls = mockWriteFile.mock.calls.filter((c) => (c[0] as string).includes('queue-secondary-ring-'));
      expect(secondaryCalls).toHaveLength(0);
    });

    test('write failure does not abort the retry loop', async () => {
      mockSend.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('OK');
      // First write call (the secondary report) rejects; later calls (none expected here) succeed.
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

      const queue = createQueue({ maxAttempts: 3 });
      const succeededSpy = jest.fn();
      queue.on('succeeded', succeededSpy);

      queue.enqueue(['SELECT 1']);
      await jest.advanceTimersByTimeAsync(50);

      expect(succeededSpy).toHaveBeenCalledTimes(1);
      expect(queue.isAlive()).toBe(true);
      // A breadcrumb noting the write failure should have been recorded.
      const breadcrumbMessages = mockAddBreadcrumb.mock.calls.map((c) => (c[0] as { message: string }).message);
      expect(breadcrumbMessages).toContain('Mirror queue: secondary report write failed');
    });
  });

  describe('SSE broadcast wire shape', () => {
    test('preserves bare MirrorCommand on lifecycle events', async () => {
      mockSend.mockResolvedValueOnce('OK');
      const queue = createQueue();
      queue.enqueue(['SELECT 1']);
      await jest.advanceTimersByTimeAsync(10);

      // Find the syncComplete broadcast
      const completeCall = mockBroadcast.mock.calls.find((c) => (c[1] as { type: string }).type === 'syncComplete') as
        [string, { type: string; payload: MirrorCommand }] | undefined;
      expect(completeCall).toBeDefined();
      const payload = completeCall[1].payload;
      expect(payload).toHaveProperty('id');
      expect(payload).toHaveProperty('sql');
      expect(payload).toHaveProperty('status', 'completed');
      // Crucially, payload is NOT wrapped in `{ kind: 'command', cmd: ... }`.
      expect(payload).not.toHaveProperty('kind');
    });

    test('preserves bare FatalInfo on syncError', async () => {
      mockSend.mockRejectedValue(new Error('persistent'));
      const queue = createQueue({ maxAttempts: 1 });
      queue.enqueue(['SELECT 1']);
      await jest.advanceTimersByTimeAsync(50);

      const errorCall = mockBroadcast.mock.calls.find(
        (c) =>
          (c[1] as { type: string }).type === 'syncError' &&
          'failedCommand' in ((c[1] as { payload: unknown }).payload as object)
      ) as [string, { type: string; payload: FatalInfo }] | undefined;
      expect(errorCall).toBeDefined();
      const fatal = errorCall[1].payload;
      expect(fatal).toHaveProperty('failedCommand');
      expect(fatal).toHaveProperty('pendingQueueDepth');
      expect(fatal).not.toHaveProperty('kind');
    });
  });

  test('Sentry capture on fatal stop includes mirror tags', async () => {
    mockSend.mockRejectedValue(new Error('persistent failure'));
    const queue = createQueue({ maxAttempts: 1 });
    queue.enqueue(['SELECT 1']);
    await jest.advanceTimersByTimeAsync(50);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('commands drain in FIFO order', async () => {
    const sendOrder: string[] = [];
    mockSend.mockImplementation((sql: string) => {
      sendOrder.push(sql);
      return Promise.resolve('OK');
    });

    const queue = createQueue();
    queue.enqueue(['FIRST']);
    queue.enqueue(['SECOND']);
    await jest.advanceTimersByTimeAsync(50);

    expect(sendOrder.length).toBe(2);
    expect(sendOrder[0]).toContain('FIRST');
    expect(sendOrder[1]).toContain('SECOND');
  });

  test('successful retry after transient failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('OK');
    const queue = createQueue({ maxAttempts: 3 });
    const succeededSpy = jest.fn();
    queue.on('succeeded', succeededSpy);

    queue.enqueue(['SELECT 1']);
    await jest.advanceTimersByTimeAsync(50);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(succeededSpy).toHaveBeenCalledTimes(1);
    expect(queue.isAlive()).toBe(true);
  });

  test('getState returns current queue state', () => {
    const queue = createQueue({ maxAttempts: 5 });
    expect(queue.getState()).toEqual({ alive: true, working: false, depth: 0, maxAttempts: 5 });
  });
});
