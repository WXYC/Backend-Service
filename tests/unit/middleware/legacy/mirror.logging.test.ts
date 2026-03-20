jest.mock('@sentry/node', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  withScope: (fn: (scope: { setTags: jest.Mock; setExtra: jest.Mock }) => void) =>
    fn({
      setTags: jest.fn(),
      setExtra: jest.fn(),
    }),
}));

import { buildMirrorCommandSummary, getMirrorRingIndex, hashSha256Hex, summarizeSql, truncateForMirrorPayload } from '../../../../apps/backend/middleware/legacy/mirror.logging';

describe('mirror.logging', () => {
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

