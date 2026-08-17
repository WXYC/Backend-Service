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
import * as fs from 'fs';
import * as path from 'path';

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

    // No yield needed: flush() joins the send record() already kicked off,
    // rather than resolving early against the drained buffer.
    await emitter.flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(lastCommand().MetricData[0].Value).toBe(3);
  });

  it('flush() awaits a size-triggered send that is still in flight', async () => {
    // The contract a shutdown hook depends on: record() drains the buffer
    // synchronously, so a flush() that only looked at buffer.length would
    // resolve while PutMetricData was still pending and let the process exit
    // before the batch landed.
    let releaseSend: () => void = () => {};
    let sendStarted = false;
    mockSend.mockImplementation(() => {
      sendStarted = true;
      return new Promise((resolve) => {
        releaseSend = () => resolve({});
      });
    });

    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test', flushAtBufferSize: 2 });
    emitter.record({ metricName: 'Widgets' });
    emitter.record({ metricName: 'Widgets' });

    let flushResolved = false;
    const flushPromise = emitter.flush().then(() => {
      flushResolved = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(sendStarted).toBe(true);
    expect(flushResolved).toBe(false);

    releaseSend();
    await flushPromise;
    expect(flushResolved).toBe(true);
  });

  it('does not coalesce same-name, same-dimension records that carry different units', async () => {
    // Regression guard: with `unit` outside the coalesce key these two would
    // publish ONE datum of Value 251 stamped Milliseconds — summing a duration
    // and a count, under whichever unit happened to arrive first. Inert for a
    // single-unit call site; a real defect for the next consumer of this
    // shared package.
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Latency', unit: 'Milliseconds', value: 250 });
    emitter.record({ metricName: 'Latency', value: 1 });
    await emitter.flush();

    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(2);
    expect(MetricData.find((d) => d.Unit === 'Milliseconds')?.Value).toBe(250);
    expect(MetricData.find((d) => d.Unit === 'Count')?.Value).toBe(1);
  });

  it('emits the dimensionless companion if ANY record in a coalesced group asked for it', async () => {
    // First-wins would drop the alarm-input series whenever an opted-out
    // record happened to land first.
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets', dimensions: [{ name: 'Kind', value: 'a' }] });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [{ name: 'Kind', value: 'a' }],
      emitDimensionlessCompanion: true,
    });
    await emitter.flush();

    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(2);
    expect(MetricData.filter((d) => d.Dimensions.length === 0)).toHaveLength(1);
    expect(MetricData.every((d) => d.Value === 2)).toBe(true);
  });

  it('flushes on the interval when the buffer never reaches the size threshold', async () => {
    // The primary path for the BS#2169 call site: at single-digit rejections
    // per minute the buffer never reaches flushAtBufferSize, so every real
    // metric ships through this branch.
    jest.useFakeTimers();
    try {
      const emitter = createBufferedMetricEmitter({
        namespace: 'WXYC/Test',
        flushIntervalMs: 30_000,
        flushAtBufferSize: 10,
      });
      emitter.record({ metricName: 'Widgets' });

      expect(mockSend).not.toHaveBeenCalled();

      jest.advanceTimersByTime(30_000);
      await emitter.flush();

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(lastCommand().MetricData[0].Value).toBe(1);
    } finally {
      jest.useRealTimers();
    }
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
    // The dropped batch has to leave a trace — swallowing silently would make
    // a persistently unreachable CloudWatch indistinguishable from no metrics.
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('PutMetricData failed'), expect.any(Error));

    consoleErrorSpy.mockRestore();
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

/**
 * The `./metrics` subpath is a deliberate second tsup entry that the package
 * barrel must never re-export. Both `apps/backend` and `apps/auth` load the
 * barrel eagerly at Sentry preload (`node --import instrument.ts`), so a
 * re-export would pull `@aws-sdk/client-cloudwatch` into every process at
 * startup — including processes that never publish a metric. Nothing about
 * that is visible in a passing test suite: the symptom is slower boot in
 * production, which is why the invariant is pinned here rather than left to
 * the comments that explain it.
 */
describe('@wxyc/observability barrel', () => {
  const barrelPath = path.resolve(__dirname, '../../../shared/observability/src/index.ts');

  it('does not re-export the AWS-SDK-backed metrics subpath', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = fs.readFileSync(barrelPath, 'utf-8');

    // Matched on the module specifier, not the bare word: a comment
    // mentioning metrics is fine, an `export … from './metrics'` is not.
    expect(source).not.toMatch(/from\s+['"]\.\/metrics/);
    expect(source).not.toMatch(/require\(\s*['"]\.\/metrics/);
    expect(source).not.toMatch(/@aws-sdk/);
  });
});
