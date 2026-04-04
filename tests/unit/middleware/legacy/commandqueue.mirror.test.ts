import { jest } from '@jest/globals';

// Mock @wxyc/database — MirrorSQL.instance().send()
const mockSend = jest.fn<() => Promise<string>>();
jest.mock('@wxyc/database', () => ({
  MirrorSQL: {
    instance: () => ({ send: mockSend }),
  },
}));

// Mock serverEventsMgr.broadcast
jest.mock('../../../../apps/backend/utils/serverEvents', () => ({
  serverEventsMgr: { broadcast: jest.fn() },
  MirrorEvents: {
    syncStarted: 'syncStarted',
    syncProgress: 'syncProgress',
    syncComplete: 'syncComplete',
    syncRetry: 'syncRetry',
    syncError: 'syncError',
  },
}));

// Mock utilities (cryptoRandomId, expBackoffMs)
let idCounter = 0;
jest.mock('../../../../apps/backend/middleware/legacy/utilities.mirror', () => ({
  cryptoRandomId: () => `test-id-${idCounter++}`,
  expBackoffMs: () => 1, // Minimal delay for tests
}));

// Mock fs.promises for persistQueue
const mockMkdir = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockWriteFile = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.mock('fs', () => ({
  promises: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

// Suppress console.table in tests
jest.spyOn(console, 'table').mockImplementation(() => {});

import { MirrorCommandQueue } from '../../../../apps/backend/middleware/legacy/commandqueue.mirror';

describe('MirrorCommandQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    idCounter = 0;

    // Reset the singleton so each test gets a fresh queue
    // Access private static _instance
    (MirrorCommandQueue as unknown as { _instance: unknown })._instance = null;
  });

  afterEach(() => {
    jest.useRealTimers();
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

  test('enqueue wraps SQL in a transaction and adds to queue', () => {
    const queue = createQueue();
    const cmd = queue.enqueue(['SELECT 1', 'SELECT 2']);

    expect(cmd).not.toBeNull();
    expect(cmd!.sql).toContain('START TRANSACTION;');
    expect(cmd!.sql).toContain('SELECT 1;');
    expect(cmd!.sql).toContain('SELECT 2;');
    expect(cmd!.sql).toContain('COMMIT;');
    // Status may already be 'in_progress' since enqueue() kicks the work loop
    expect(['pending', 'in_progress']).toContain(cmd!.status);
  });

  test('successful command emits succeeded event', async () => {
    mockSend.mockResolvedValueOnce('OK');
    const queue = createQueue();
    const succeededSpy = jest.fn();
    queue.on('succeeded', succeededSpy);

    queue.enqueue(['SELECT 1']);

    // Allow the async workLoop to run
    await jest.advanceTimersByTimeAsync(10);

    expect(succeededSpy).toHaveBeenCalledTimes(1);
    expect(succeededSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', attempts: 1 })
    );
  });

  test('failed command retries up to maxAttempts', async () => {
    mockSend
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'));

    const queue = createQueue({ maxAttempts: 3 });
    const failedAttemptSpy = jest.fn();
    const fatalSpy = jest.fn();
    queue.on('failedAttempt', failedAttemptSpy);
    queue.on('fatal', fatalSpy);

    queue.enqueue(['SELECT 1']);

    // Process first attempt
    await jest.advanceTimersByTimeAsync(10);
    // Process retry after backoff
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(10);
    // Third attempt triggers fatal
    await jest.advanceTimersByTimeAsync(10);

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(queue.isDead()).toBe(true);
    expect(queue.isAlive()).toBe(false);
  });

  test('dead queue rejects new commands', async () => {
    mockSend.mockRejectedValue(new Error('always fails'));

    const queue = createQueue({ maxAttempts: 1 });
    queue.enqueue(['SELECT 1']);

    // Let the single attempt fail and trigger fatal
    await jest.advanceTimersByTimeAsync(50);

    expect(queue.isDead()).toBe(true);

    const cmd = queue.enqueue(['SELECT 2']);
    expect(cmd).toBeNull();
  });

  test('fatal stop persists queue to disk', async () => {
    mockSend.mockRejectedValue(new Error('persistent failure'));

    const queue = createQueue({ maxAttempts: 1 });
    queue.enqueue(['SELECT 1']);

    await jest.advanceTimersByTimeAsync(50);

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/test-mirror-logs', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    const [filePath, content] = mockWriteFile.mock.calls[0] as [string, string];
    expect(filePath).toContain('queue-fatal-');
    const parsed = JSON.parse(content);
    expect(parsed.reason).toContain('maxAttempts=1');
    expect(parsed.failedCommand.sql).toContain('SELECT 1');
  });

  test('getState returns current queue state', () => {
    const queue = createQueue({ maxAttempts: 5 });
    const state = queue.getState();

    expect(state.alive).toBe(true);
    expect(state.working).toBe(false);
    expect(state.depth).toBe(0);
    expect(state.maxAttempts).toBe(5);
  });

  test('commands drain in FIFO order', async () => {
    const sendOrder: string[] = [];
    mockSend.mockImplementation(async (sql: string) => {
      sendOrder.push(sql);
      return 'OK';
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
    mockSend
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('OK');

    const queue = createQueue({ maxAttempts: 3 });
    const succeededSpy = jest.fn();
    queue.on('succeeded', succeededSpy);

    queue.enqueue(['SELECT 1']);

    // First attempt fails
    await jest.advanceTimersByTimeAsync(10);
    // Retry succeeds after backoff
    await jest.advanceTimersByTimeAsync(10);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(succeededSpy).toHaveBeenCalledTimes(1);
    expect(queue.isAlive()).toBe(true);
  });
});
