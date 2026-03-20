const mockSend = jest.fn();
const mockBroadcast = jest.fn();
const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
const mockAddMirrorBreadcrumb = jest.fn();
const mockCaptureMirrorException = jest.fn();

jest.mock('@wxyc/database', () => ({
  MirrorSQL: {
    instance: jest.fn(() => ({
      send: mockSend,
    })),
  },
}));

jest.mock('fs', () => ({
  promises: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
  },
}));

jest.mock('../../../../apps/backend/utils/serverEvents', () => ({
  MirrorEvents: {
    syncStarted: 'sync-started',
    syncProgress: 'sync-progress',
    syncComplete: 'sync-complete',
    syncRetry: 'sync-retry',
    syncError: 'sync-error',
  },
  serverEventsMgr: {
    broadcast: mockBroadcast,
  },
}));

jest.mock('../../../../apps/backend/middleware/legacy/mirror.logging', () => ({
  addMirrorBreadcrumb: mockAddMirrorBreadcrumb,
  captureMirrorException: mockCaptureMirrorException,
  getMirrorRingIndex: (nowMs: number, intervalMs: number, maxReports: number) => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) intervalMs = 1;
    if (!Number.isFinite(maxReports) || maxReports <= 0) maxReports = 1;
    const bucket = Math.floor(nowMs / intervalMs);
    return ((bucket % maxReports) + maxReports) % maxReports;
  },
  summarizeSql: (sql: string) => ({
    sqlLength: sql.length,
    sqlHash: `hash_${sql.length}`,
    sqlPreview: sql.slice(0, 256),
  }),
  hashSha256Hex: (input: string) => `hash_${input.length}`,
  truncateForMirrorPayload: (input: unknown, maxLen = 1024) => {
    if (input === undefined || input === null) return undefined;
    if (typeof input === 'string') {
      return input.length <= maxLen ? input : input.slice(0, maxLen);
    }
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
      const s = String(input);
      return s.length <= maxLen ? s : s.slice(0, maxLen);
    }
    return undefined;
  },
  buildMirrorCommandSummary: (cmd: any) => ({
    id: cmd.id,
    enqueuedAt: cmd.enqueuedAt,
    attempts: cmd.attempts,
    status: cmd.status,
    lastError: cmd.lastError ? String(cmd.lastError).slice(0, 1024) : undefined,
    sqlLength: cmd.sqlLength,
    sqlHash: cmd.sqlHash,
    statementsCount: cmd.statementsCount,
    context: cmd.context,
  }),
}));

import { MirrorCommandQueue } from '../../../../apps/backend/middleware/legacy/commandqueue.mirror';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('commandqueue.mirror', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (MirrorCommandQueue as any)._instance = null;
    delete process.env.MIRROR_SECONDARY_REPORT_ON_ATTEMPT;
    delete process.env.MIRROR_SECONDARY_REPORTS_MAX;
    delete process.env.MIRROR_SECONDARY_REPORTS_INTERVAL_MS;
    delete process.env.MIRROR_FATAL_REPORTS_MAX;
    delete process.env.MIRROR_FATAL_REPORTS_INTERVAL_MS;
    delete process.env.MIRROR_PENDING_QUEUE_SUMMARIES_MAX;
    delete process.env.MIRROR_REPORT_MAX_BYTES;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('processes happy-path command and captures SQL summary metadata', async () => {
    mockSend.mockResolvedValueOnce('ok');
    const queue = MirrorCommandQueue.instance({
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      jitterMs: 0,
      logFile: '/tmp/mirror-logs-test',
    });

    const cmd = queue.enqueue(['SELECT 1'], { operation: 'flowsheet.addEntry', requestId: 'req-1' });
    await flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(cmd).not.toBeNull();
    expect(cmd?.sqlLength).toBeGreaterThan(0);
    expect(cmd?.sqlHash).toBeDefined();
    expect(cmd?.statementsCount).toBe(1);
    expect(cmd?.status).toBe('completed');
    expect(mockCaptureMirrorException).not.toHaveBeenCalled();
  });

  it('retries after failure and writes secondary ring report deterministically', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-19T00:00:05.000Z'));

    process.env.MIRROR_SECONDARY_REPORT_ON_ATTEMPT = '1';
    process.env.MIRROR_SECONDARY_REPORTS_MAX = '10';
    process.env.MIRROR_SECONDARY_REPORTS_INTERVAL_MS = '10000';

    mockSend.mockRejectedValueOnce(new Error('boom-1')).mockResolvedValueOnce('ok');

    const queue = MirrorCommandQueue.instance({
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      jitterMs: 0,
      logFile: '/tmp/mirror-logs-test',
    });

    queue.enqueue(['SELECT 1'], { operation: 'flowsheet.updateEntry', requestId: 'req-2' });
    await flush();
    jest.advanceTimersByTime(5);
    await flush();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('queue-secondary-ring-0.json'),
      expect.any(String),
      'utf8'
    );
    expect(mockAddMirrorBreadcrumb).toHaveBeenCalled();
  });

  it('captures fatal to sentry and writes bounded fatal ring payload without raw SQL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-19T00:00:25.000Z')); // bucket index 2 for 10s interval

    process.env.MIRROR_FATAL_REPORTS_MAX = '10';
    process.env.MIRROR_FATAL_REPORTS_INTERVAL_MS = '10000';
    process.env.MIRROR_REPORT_MAX_BYTES = '220';

    mockSend.mockRejectedValueOnce(new Error('fatal-db-down'));

    const queue = MirrorCommandQueue.instance({
      maxAttempts: 1,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      jitterMs: 0,
      logFile: '/tmp/mirror-logs-test',
    });

    queue.enqueue(["SELECT * FROM BIG_TABLE WHERE payload = '" + 'x'.repeat(5000) + "'"], {
      operation: 'flowsheet.deleteEntry',
      requestId: 'req-3',
    });
    await flush();

    expect(mockCaptureMirrorException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: 'flowsheet.deleteEntry',
        attempt: 1,
        maxAttempts: 1,
      }),
      expect.objectContaining({
        statementsCount: 1,
      })
    );

    expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining('queue-fatal-ring-2.json'), expect.any(String), 'utf8');
    const payload = mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1] as string;
    expect(payload).not.toContain('START TRANSACTION;');
    expect(payload).not.toContain('BIG_TABLE');

    const parsed = JSON.parse(payload);
    const failedCmd = parsed.failedCommand ?? {};
    expect(failedCmd.sqlLength ?? parsed.failedCommand?.sqlLength).toBeDefined();
    expect(failedCmd.sqlHash ?? parsed.failedCommand?.sqlHash).toBeDefined();
    expect(failedCmd.statementsCount ?? parsed.failedCommand?.statementsCount).toBeDefined();
    expect(failedCmd.sql).toBeUndefined();
  });
});

