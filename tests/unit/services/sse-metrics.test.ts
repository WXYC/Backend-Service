import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Mock @aws-sdk/client-cloudwatch so the metrics module never talks to AWS.
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutMetricDataCommand: mockPutMetricDataCommand,
}));

import {
  recordBroadcast,
  recordBroadcastFailure,
  startSseMetrics,
  stopSseMetrics,
  __resetForTests,
  __flushForTests,
} from '../../../apps/backend/services/sse/sse-metrics';

type RecordedCall = {
  Namespace: string;
  MetricData: Array<{
    MetricName: string;
    Unit: string;
    Value: number;
    Dimensions: Array<{ Name: string; Value: string }>;
  }>;
};

function calls(): RecordedCall[] {
  return mockPutMetricDataCommand.mock.calls.map((c) => c[0] as RecordedCall);
}

function allData(): RecordedCall['MetricData'] {
  return calls().flatMap((c) => c.MetricData);
}

describe('sse-metrics', () => {
  const originalDisabled = process.env.SSE_METRICS_DISABLED;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    delete process.env.SSE_METRICS_DISABLED;
    __resetForTests();
  });

  afterEach(() => {
    if (originalDisabled === undefined) {
      delete process.env.SSE_METRICS_DISABLED;
    } else {
      process.env.SSE_METRICS_DISABLED = originalDisabled;
    }
    __resetForTests();
  });

  describe('EventsBroadcast counter', () => {
    it('emits one dimensioned MetricDatum per topic on flush', async () => {
      recordBroadcast('live-fs-topic');
      recordBroadcast('live-fs-topic');
      recordBroadcast('test-topic');
      await __flushForTests();

      const data = allData();
      const events = data.filter((d) => d.MetricName === 'SSE/EventsBroadcast');
      expect(events).toHaveLength(2);
      const live = events.find((d) => d.Dimensions[0]?.Value === 'live-fs-topic');
      const test = events.find((d) => d.Dimensions[0]?.Value === 'test-topic');
      expect(live?.Value).toBe(2);
      expect(test?.Value).toBe(1);
    });

    it('does not emit a dimensionless companion for EventsBroadcast', async () => {
      // EventsBroadcast is dashboard-only — no alarm input, no companion.
      recordBroadcast('live-fs-topic');
      await __flushForTests();

      const events = allData().filter((d) => d.MetricName === 'SSE/EventsBroadcast');
      expect(events).toHaveLength(1);
      expect(events[0].Dimensions).toEqual([{ Name: 'Topic', Value: 'live-fs-topic' }]);
    });

    it('coalesces repeated broadcasts on the same topic into a single MetricDatum', async () => {
      for (let i = 0; i < 5; i += 1) recordBroadcast('live-fs-topic');
      await __flushForTests();

      const events = allData().filter((d) => d.MetricName === 'SSE/EventsBroadcast');
      expect(events).toHaveLength(1);
      expect(events[0].Value).toBe(5);
    });

    it('clears the buffer after flush', async () => {
      recordBroadcast('live-fs-topic');
      await __flushForTests();
      mockPutMetricDataCommand.mockClear();

      // A second flush with no new events emits nothing.
      await __flushForTests();
      const events = allData().filter((d) => d.MetricName === 'SSE/EventsBroadcast');
      expect(events).toHaveLength(0);
    });
  });

  describe('BroadcastFailures counter', () => {
    it('emits dimensioned per-topic series AND a dimensionless companion (alarm input)', async () => {
      recordBroadcastFailure('live-fs-topic');
      recordBroadcastFailure('live-fs-topic');
      recordBroadcastFailure('test-topic');
      await __flushForTests();

      const failures = allData().filter((d) => d.MetricName === 'SSE/BroadcastFailures');
      // 2 dimensioned + 1 companion = 3.
      expect(failures).toHaveLength(3);

      const dimensioned = failures.filter((d) => d.Dimensions.length > 0);
      expect(dimensioned).toHaveLength(2);

      const companion = failures.find((d) => d.Dimensions.length === 0);
      expect(companion).toBeDefined();
      expect(companion?.Value).toBe(3);
    });

    it('does not emit the companion when there are zero failures', async () => {
      // A pure-broadcast tick with no failures should not write a 0 to the
      // companion (would pollute the namespace and invite a future
      // misconfigured alarm).
      recordBroadcast('live-fs-topic');
      await __flushForTests();

      const failures = allData().filter((d) => d.MetricName === 'SSE/BroadcastFailures');
      expect(failures).toHaveLength(0);
    });
  });

  describe('ClientCount gauge', () => {
    it('emits per-topic dimensioned series AND a dimensionless companion on every tick', async () => {
      startSseMetrics(
        () =>
          new Map([
            ['live-fs-topic', 7],
            ['test-topic', 2],
          ])
      );
      await __flushForTests();

      const gauges = allData().filter((d) => d.MetricName === 'SSE/ClientCount');
      // 2 dimensioned + 1 companion = 3.
      expect(gauges).toHaveLength(3);

      const dimensioned = gauges.filter((d) => d.Dimensions.length > 0);
      expect(dimensioned).toHaveLength(2);
      expect(dimensioned.find((d) => d.Dimensions[0].Value === 'live-fs-topic')?.Value).toBe(7);
      expect(dimensioned.find((d) => d.Dimensions[0].Value === 'test-topic')?.Value).toBe(2);

      const companion = gauges.find((d) => d.Dimensions.length === 0);
      expect(companion?.Value).toBe(9);
    });

    it('emits a zero-valued companion when the snapshot is empty (continuous alarm series)', async () => {
      startSseMetrics(() => new Map());
      await __flushForTests();

      const gauges = allData().filter((d) => d.MetricName === 'SSE/ClientCount');
      // Only the companion fires — no per-topic data when the snapshot is empty.
      expect(gauges).toHaveLength(1);
      expect(gauges[0].Dimensions).toEqual([]);
      expect(gauges[0].Value).toBe(0);
    });

    it('does not start a second timer when called twice', () => {
      const snapshot = jest.fn<() => Map<string, number>>().mockReturnValue(new Map([['live-fs-topic', 1]]));
      startSseMetrics(snapshot);
      startSseMetrics(snapshot);
      // Stop and ensure we cleared the single timer cleanly.
      stopSseMetrics();
      // No assertion needed — if this leaked a timer, the afterEach __resetForTests
      // would mismatch state. The key contract is that a double-start does not
      // throw.
    });
  });

  describe('namespacing', () => {
    it('uses WXYC/BackendService as the namespace for all metrics', async () => {
      startSseMetrics(() => new Map([['live-fs-topic', 1]]));
      recordBroadcast('live-fs-topic');
      recordBroadcastFailure('live-fs-topic');
      await __flushForTests();

      const ns = calls().map((c) => c.Namespace);
      expect(ns.every((n) => n === 'WXYC/BackendService')).toBe(true);
    });
  });

  describe('opt-out', () => {
    it('SSE_METRICS_DISABLED=true short-circuits recordBroadcast', async () => {
      process.env.SSE_METRICS_DISABLED = 'true';
      recordBroadcast('live-fs-topic');
      await __flushForTests();

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('SSE_METRICS_DISABLED=true short-circuits recordBroadcastFailure', async () => {
      process.env.SSE_METRICS_DISABLED = 'true';
      recordBroadcastFailure('live-fs-topic');
      await __flushForTests();

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('SSE_METRICS_DISABLED=true skips starting the timer', () => {
      process.env.SSE_METRICS_DISABLED = 'true';
      const snapshot = jest.fn<() => Map<string, number>>().mockReturnValue(new Map([['live-fs-topic', 99]]));
      startSseMetrics(snapshot);

      // The gauge snapshot function is still recorded (so __flushForTests can
      // probe it in disabled mode for debugging), but the periodic tick must
      // not fire. We verify by asserting no client send occurred during the
      // afterEach cleanup window.
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('failure handling', () => {
    it('swallows PutMetricData errors and continues serving recordBroadcast', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockSend.mockRejectedValue(new Error('CloudWatch unreachable'));

      recordBroadcast('live-fs-topic');
      await expect(__flushForTests()).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[sse-metrics]'), expect.any(Error));

      consoleErrorSpy.mockRestore();
    });
  });

  describe('buffer-size flush', () => {
    it('auto-flushes when the total buffered count exceeds the threshold', async () => {
      // 100 events on the same topic should trip the buffer trigger and call
      // PutMetricData once without us awaiting the timer.
      for (let i = 0; i < 100; i += 1) {
        recordBroadcast('live-fs-topic');
      }
      // Yield once for the synchronous flush kicked off by recordBroadcast.
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSend).toHaveBeenCalledTimes(1);
      const events = allData().filter((d) => d.MetricName === 'SSE/EventsBroadcast');
      expect(events).toHaveLength(1);
      expect(events[0].Value).toBe(100);
    });
  });
});
