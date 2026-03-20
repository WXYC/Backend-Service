const mockAddBreadcrumb = jest.fn();
const mockCaptureException = jest.fn();
const mockSetTags = jest.fn();
const mockSetExtra = jest.fn();
const mockWithScope = jest.fn((fn: (scope: { setTags: jest.Mock; setExtra: jest.Mock }) => void) =>
  fn({
    setTags: mockSetTags,
    setExtra: mockSetExtra,
  })
);

jest.mock('@sentry/node', () => ({
  addBreadcrumb: mockAddBreadcrumb,
  captureException: mockCaptureException,
  withScope: mockWithScope,
}), { virtual: true });

import {
  addMirrorBreadcrumb,
  buildMirrorCommandSummary,
  captureMirrorException,
  getMirrorRingIndex,
  hashSha256Hex,
  summarizeSql,
  truncateForMirrorPayload,
} from '../../../../apps/backend/middleware/legacy/mirror.logging';

describe('mirror.logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMirrorRingIndex', () => {
    it('returns 0 for first bucket', () => {
      expect(getMirrorRingIndex(0, 1000, 10)).toBe(0);
      expect(getMirrorRingIndex(999, 1000, 10)).toBe(0);
    });

    it('increments bucket index after interval', () => {
      expect(getMirrorRingIndex(1000, 1000, 10)).toBe(1);
      expect(getMirrorRingIndex(1999, 1000, 10)).toBe(1);
      expect(getMirrorRingIndex(2000, 1000, 10)).toBe(2);
    });

    it('wraps around using modulo maxReports', () => {
      const intervalMs = 1000;
      const maxReports = 10;
      expect(getMirrorRingIndex(10_000, intervalMs, maxReports)).toBe(0); // bucket=10 -> 10%10
      expect(getMirrorRingIndex(10_001, intervalMs, maxReports)).toBe(0); // still bucket=10
    });

    it('is deterministic under fake timers', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-19T00:00:05.000Z'));
      const nowMs = Date.now();
      // interval=10s buckets => 5s -> bucket0 => index0
      expect(getMirrorRingIndex(nowMs, 10_000, 10)).toBe(0);
      jest.useRealTimers();
    });

    it('falls back to safe defaults for invalid inputs', () => {
      expect(getMirrorRingIndex(1000, 0, 0)).toBe(0);
      expect(getMirrorRingIndex(1000, -10, -2)).toBe(0);
    });
  });

  describe('summarizeSql and hash helpers', () => {
    it('summarizeSql returns sqlLength and stable sqlHash', () => {
      const sql = 'SELECT 1;';
      const summary = summarizeSql(sql);
      expect(summary.sqlLength).toBe(sql.length);
      expect(summary.sqlHash).toBe(hashSha256Hex(sql));
    });
  });

  describe('truncateForMirrorPayload', () => {
    it('truncates long strings', () => {
      const s = 'a'.repeat(2000);
      const out = truncateForMirrorPayload(s, 10);
      expect(out).toHaveLength(10);
    });
  });

  describe('addMirrorBreadcrumb', () => {
    it('emits mirror breadcrumb with mirror_cmd_id from context', () => {
      addMirrorBreadcrumb(
        'Mirror enqueue',
        { statementsCount: 2 },
        { mirrorCmdId: 'cmd-123', operation: 'flowsheet.addEntry' },
        'info'
      );
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'mirror',
          message: 'Mirror enqueue',
          level: 'info',
          data: expect.objectContaining({
            statementsCount: 2,
            mirror_cmd_id: 'cmd-123',
          }),
        })
      );
    });

    it('swallows sentry breadcrumb exceptions', () => {
      mockAddBreadcrumb.mockImplementationOnce(() => {
        throw new Error('sentry down');
      });
      expect(() => addMirrorBreadcrumb('x', {}, { mirrorCmdId: 'cmd-1' })).not.toThrow();
    });
  });

  describe('captureMirrorException', () => {
    it('sets expected sentry tags and extras', () => {
      captureMirrorException(
        new Error('boom'),
        {
          requestId: 'req-1',
          operation: 'flowsheet.addEntry',
          mirrorCmdId: 'cmd-1',
          showId: 42,
          djId: 'dj-1',
          route: '/flowsheet',
          method: 'POST',
          httpStatus: 200,
          attempt: 2,
          maxAttempts: 5,
          mirrorFeatureEnabled: true,
        },
        {
          sql_preview: 'SELECT * FROM t',
        }
      );

      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTags).toHaveBeenCalledWith(
        expect.objectContaining({
          request_id: 'req-1',
          mirror_operation: 'flowsheet.addEntry',
          mirror_cmd_id: 'cmd-1',
          show_id: '42',
          dj_id: 'dj-1',
          route: '/flowsheet',
          method: 'POST',
          http_status: '200',
          attempt: '2',
          max_attempts: '5',
          mirror_feature_enabled: 'true',
        })
      );
      expect(mockSetExtra).toHaveBeenCalledWith('mirror', expect.objectContaining({ sql_preview: 'SELECT * FROM t' }));
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it('swallows sentry scope exceptions', () => {
      mockWithScope.mockImplementationOnce(() => {
        throw new Error('scope fail');
      });
      expect(() => captureMirrorException(new Error('boom'), { operation: 'flowsheet.addEntry' })).not.toThrow();
    });
  });

  describe('buildMirrorCommandSummary', () => {
    it('omits full SQL and truncates lastError', () => {
      const cmd = {
        id: 'cmd-1',
        enqueuedAt: 1,
        attempts: 2,
        status: 'failed' as const,
        lastError: 'b'.repeat(5000),
        sqlLength: 1234,
        sqlHash: 'hash-1',
        statementsCount: 3,
        context: {
          operation: 'flowsheet.addEntry',
          requestId: 'req-1',
          showId: 123,
        },
      };

      const summary = buildMirrorCommandSummary(cmd);
      expect(summary).toHaveProperty('sqlLength', 1234);
      expect(summary).toHaveProperty('sqlHash', 'hash-1');
      expect(summary).toHaveProperty('statementsCount', 3);
      expect((summary as any).sql).toBeUndefined();
      expect(summary.lastError).toBeDefined();
      expect(summary.lastError!.length).toBeLessThanOrEqual(1024);
    });
  });
});

