import { jest } from '@jest/globals';

const mockAddBreadcrumb = jest.fn();
const mockCaptureException = jest.fn();
const mockSetTags = jest.fn();
const mockSetExtra = jest.fn();
const mockWithScope = jest.fn((fn: (scope: unknown) => void) => fn({ setTags: mockSetTags, setExtra: mockSetExtra }));

jest.mock('@sentry/node', () => ({
  addBreadcrumb: (...args: unknown[]) => mockAddBreadcrumb(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  withScope: (fn: (scope: unknown) => void) => mockWithScope(fn),
}));

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

  describe('summarizeSql', () => {
    test('returns deterministic length and sha256 hash', () => {
      const sql = 'INSERT INTO foo VALUES (1);';
      const summary = summarizeSql(sql);

      expect(summary.sqlLength).toBe(sql.length);
      expect(summary.sqlHash).toBe(hashSha256Hex(sql));
      expect(summary.sqlHash).toHaveLength(64);
    });

    test('does not include a sql preview (no leak surface)', () => {
      const summary = summarizeSql("INSERT INTO foo VALUES ('secret');");
      expect(summary).not.toHaveProperty('sqlPreview');
      expect(JSON.stringify(summary)).not.toContain('secret');
    });

    test('different SQL strings produce different hashes', () => {
      expect(summarizeSql('a').sqlHash).not.toBe(summarizeSql('b').sqlHash);
    });
  });

  describe('getMirrorRingIndex', () => {
    test('cycles through buckets', () => {
      const interval = 1000;
      const max = 4;
      expect(getMirrorRingIndex(0, interval, max)).toBe(0);
      expect(getMirrorRingIndex(1000, interval, max)).toBe(1);
      expect(getMirrorRingIndex(2000, interval, max)).toBe(2);
      expect(getMirrorRingIndex(3000, interval, max)).toBe(3);
      expect(getMirrorRingIndex(4000, interval, max)).toBe(0);
    });

    test('handles non-positive interval defensively', () => {
      const idx = getMirrorRingIndex(123, 0, 5);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(5);
    });

    test('handles non-positive max defensively (collapses to slot 0)', () => {
      expect(getMirrorRingIndex(123, 1000, 0)).toBe(0);
      expect(getMirrorRingIndex(123, 1000, -3)).toBe(0);
    });

    test('handles non-finite inputs without throwing', () => {
      expect(() => getMirrorRingIndex(Date.now(), Number.NaN, Number.POSITIVE_INFINITY)).not.toThrow();
    });
  });

  describe('addMirrorBreadcrumb', () => {
    test('forwards category, message, level, and merged data', () => {
      addMirrorBreadcrumb('hello', { foo: 'bar' }, { mirrorCmdId: 'cmd-1', requestId: 'req-1' });

      expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
      const arg = mockAddBreadcrumb.mock.calls[0][0] as {
        category: string;
        message: string;
        level: string;
        data: Record<string, unknown>;
      };
      expect(arg.category).toBe('mirror');
      expect(arg.message).toBe('hello');
      expect(arg.level).toBe('info');
      expect(arg.data).toMatchObject({ foo: 'bar', mirror_cmd_id: 'cmd-1', request_id: 'req-1' });
    });

    test('truncates oversize message bodies', () => {
      addMirrorBreadcrumb('x'.repeat(500));
      const arg = mockAddBreadcrumb.mock.calls[0][0] as { message: string };
      expect(arg.message.length).toBeLessThanOrEqual(200);
    });

    test('never throws when Sentry throws', () => {
      mockAddBreadcrumb.mockImplementationOnce(() => {
        throw new Error('sentry exploded');
      });
      expect(() => addMirrorBreadcrumb('hello')).not.toThrow();
    });
  });

  describe('captureMirrorException', () => {
    test('sets subsystem tag and forwards the error', () => {
      const err = new Error('boom');
      captureMirrorException(err, { mirrorCmdId: 'cmd-1', attempt: 3, maxAttempts: 5 });

      expect(mockWithScope).toHaveBeenCalledTimes(1);
      expect(mockSetTags).toHaveBeenCalledWith(
        expect.objectContaining({
          subsystem: 'legacy-mirror',
          mirror_cmd_id: 'cmd-1',
          attempt: '3',
          max_attempts: '5',
        })
      );
      expect(mockCaptureException).toHaveBeenCalledWith(err);
    });

    test('wraps non-Error values', () => {
      captureMirrorException('not an error', { mirrorCmdId: 'cmd-1' });
      const passed = mockCaptureException.mock.calls[0][0] as Error;
      expect(passed).toBeInstanceOf(Error);
      expect(passed.message).toBe('not an error');
    });

    test('truncates string values in extra payload', () => {
      captureMirrorException(new Error('boom'), { mirrorCmdId: 'cmd-1' }, { huge: 'x'.repeat(5000) });
      const extras = mockSetExtra.mock.calls.find((c) => (c[0] as string) === 'mirror') as
        | [string, { huge: string }]
        | undefined;
      expect(extras).toBeDefined();
      expect(extras[1].huge.length).toBeLessThanOrEqual(1024);
    });

    test('never throws when Sentry throws', () => {
      mockWithScope.mockImplementationOnce(() => {
        throw new Error('sentry exploded');
      });
      expect(() => captureMirrorException(new Error('boom'), { mirrorCmdId: 'cmd-1' })).not.toThrow();
    });
  });

  describe('buildMirrorCommandSummary', () => {
    test('passes through fingerprint fields and truncates lastError', () => {
      const summary = buildMirrorCommandSummary({
        id: 'cmd-1',
        enqueuedAt: 1000,
        attempts: 2,
        status: 'failed',
        lastError: 'x'.repeat(5000),
        sqlLength: 42,
        sqlHash: 'deadbeef',
        statementsCount: 3,
      });

      expect(summary.sqlLength).toBe(42);
      expect(summary.sqlHash).toBe('deadbeef');
      expect(summary.statementsCount).toBe(3);
      expect(summary.lastError.length).toBeLessThanOrEqual(1024);
    });
  });

  describe('truncateForMirrorPayload', () => {
    test('returns undefined for null/undefined inputs', () => {
      expect(truncateForMirrorPayload(undefined)).toBeUndefined();
      expect(truncateForMirrorPayload(null)).toBeUndefined();
    });

    test('respects custom max length', () => {
      const out = truncateForMirrorPayload('abcdefghij', 4);
      expect(out).toBe('abcd');
    });
  });
});
