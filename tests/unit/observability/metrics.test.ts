/**
 * Unit tests for the generic buffered CloudWatch metric emitter (BS#2169).
 *
 * Ownership split: this file covers the generic emitter mechanics only
 * (buffering, flush-on-interval-vs-size, coalescing, swallow-on-failure,
 * the disabled short-circuit, the optional dimensionless companion).
 * Auth-specific wiring (namespace, metric name, dimension set, the
 * AUTH_RATE_LIMIT_METRICS_DISABLED short-circuit) is covered separately by
 * tests/unit/auth/auth-rate-limit-metrics.test.ts.
 *
 * Also exercises the `@wxyc/observability/metrics` subpath resolution
 * itself: jest.unit.config.ts's moduleNameMapper and tests/tsconfig.json's
 * `paths` both need a dedicated entry for this subpath (the bare
 * `@wxyc/observability` mapping does not also match it) — a resolution gap
 * that type-checks fine in an editor but fails ts-jest at CI time. This
 * suite passing is the verification that both are wired correctly.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutMetricDataCommand: mockPutMetricDataCommand,
}));

import { createBufferedMetricEmitter } from '@wxyc/observability/metrics';

interface CapturedCommand {
  Namespace: string;
  MetricData: Array<{
    MetricName: string;
    Unit: string;
    Value: number;
    Dimensions: Array<{ Name: string; Value: string }>;
  }>;
}

function lastCommand(): CapturedCommand {
  const calls = mockPutMetricDataCommand.mock.calls;
  return calls[calls.length - 1][0] as CapturedCommand;
}

describe('createBufferedMetricEmitter', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
  });

  it('publishes to the configured namespace', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    expect(lastCommand().Namespace).toBe('WXYC/Test');
  });

  it('defaults value to 1, unit to Count, and dimensions to []', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    const [datum] = lastCommand().MetricData;
    expect(datum.Value).toBe(1);
    expect(datum.Unit).toBe('Count');
    expect(datum.Dimensions).toEqual([]);
  });

  it('coalesces identical (metricName, dimensions) pairs into one summed datum', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets', dimensions: [{ name: 'Kind', value: 'a' }] });
    emitter.record({ metricName: 'Widgets', dimensions: [{ name: 'Kind', value: 'a' }] });
    emitter.record({ metricName: 'Widgets', dimensions: [{ name: 'Kind', value: 'a' }] });
    await emitter.flush();

    expect(mockPutMetricDataCommand).toHaveBeenCalledTimes(1);
    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(1);
    expect(MetricData[0].Value).toBe(3);
  });

  it('coalescing is order-independent on the dimension set (Kind=a,Env=b === Env=b,Kind=a)', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [
        { name: 'Kind', value: 'a' },
        { name: 'Env', value: 'b' },
      ],
    });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [
        { name: 'Env', value: 'b' },
        { name: 'Kind', value: 'a' },
      ],
    });
    await emitter.flush();

    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(1);
    expect(MetricData[0].Value).toBe(2);
  });

  it('keeps distinct dimension values as separate datums', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets', dimensions: [{ name: 'Kind', value: 'a' }] });
    emitter.record({ metricName: 'Widgets', dimensions: [{ name: 'Kind', value: 'b' }] });
    await emitter.flush();

    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(2);
    expect(MetricData.map((d) => d.Value).sort()).toEqual([1, 1]);
  });

  it('flushes automatically once the buffer reaches flushAtBufferSize, without waiting for the interval', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test', flushAtBufferSize: 3 });
    emitter.record({ metricName: 'Widgets' });
    emitter.record({ metricName: 'Widgets' });
    emitter.record({ metricName: 'Widgets' });

    // Yield once for the synchronous flush kicked off inside record().
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(lastCommand().MetricData[0].Value).toBe(3);
  });

  it('does not flush before the size threshold or a forced flush', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test', flushAtBufferSize: 10 });
    emitter.record({ metricName: 'Widgets' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('swallows a rejected PutMetricData rather than throwing', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSend.mockRejectedValue(new Error('CloudWatch unreachable'));

    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets' });

    await expect(emitter.flush()).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it('routes a flush failure to onFlushError when supplied, instead of console.error', async () => {
    const onFlushError = jest.fn();
    mockSend.mockRejectedValue(new Error('CloudWatch unreachable'));

    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test', onFlushError });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    expect(onFlushError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('does not call PutMetricData when isDisabled() returns true', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test', isDisabled: () => true });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPutMetricDataCommand).not.toHaveBeenCalled();
  });

  it('emits a dimensionless companion only when emitDimensionlessCompanion is explicitly set', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [{ name: 'Kind', value: 'a' }],
      emitDimensionlessCompanion: true,
    });
    await emitter.flush();

    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(2);
    const dimensioned = MetricData.filter((d) => d.Dimensions.length > 0);
    const dimensionless = MetricData.filter((d) => d.Dimensions.length === 0);
    expect(dimensioned).toHaveLength(1);
    expect(dimensionless).toHaveLength(1);
    expect(dimensionless[0].Value).toBe(dimensioned[0].Value);
  });

  it('emits no dimensionless companion by default', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets', dimensions: [{ name: 'Kind', value: 'a' }] });
    await emitter.flush();

    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(1);
    expect(MetricData.some((d) => d.Dimensions.length === 0)).toBe(false);
  });

  it('reset() clears buffered state so a pending record is dropped, not flushed on the next call', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets' });
    emitter.reset();
    await emitter.flush();

    expect(mockSend).not.toHaveBeenCalled();
  });
});
