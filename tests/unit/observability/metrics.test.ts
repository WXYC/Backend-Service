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
 * BS#2191 extensions. Each exists because a call site being migrated onto this
 * emitter publishes a shape the emitter could not previously express — and a
 * flag with no test is how a companion silently changes shape, so the effect
 * of each one is pinned here rather than left to the call-site suites.
 */
describe('createBufferedMetricEmitter — dimensionless companion modes', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
  });

  it("treats emitDimensionlessCompanion: true as 'perEntry'", async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [{ name: 'Kind', value: 'a' }],
      emitDimensionlessCompanion: true,
    });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [{ name: 'Kind', value: 'b' }],
      emitDimensionlessCompanion: 'perEntry',
    });
    await emitter.flush();

    const { MetricData } = lastCommand();
    // Two slices, each with its own companion: 2 + 2.
    expect(MetricData).toHaveLength(4);
    expect(MetricData.filter((d) => d.Dimensions.length === 0)).toHaveLength(2);
  });

  it("emits ONE summed companion per (metricName, unit) under 'aggregated'", async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [{ name: 'Topic', value: 'a' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [{ name: 'Topic', value: 'a' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    emitter.record({
      metricName: 'Widgets',
      dimensions: [{ name: 'Topic', value: 'b' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    await emitter.flush();

    const { MetricData } = lastCommand();
    // 2 dimensioned slices + exactly 1 companion = 3.
    expect(MetricData).toHaveLength(3);
    const dimensioned = MetricData.filter((d) => d.Dimensions.length > 0);
    const dimensionless = MetricData.filter((d) => d.Dimensions.length === 0);
    expect(dimensioned.map((d) => d.Value).sort()).toEqual([1, 2]);
    expect(dimensionless).toHaveLength(1);
    expect(dimensionless[0].Value).toBe(3);
  });

  it("'perEntry' and 'aggregated' agree under Sum and disagree under every other Statistic", async () => {
    // The whole reason the mode is a knob rather than a default. Same inputs,
    // same Sum (3), different point counts and therefore different Average /
    // Maximum / SampleCount — so an alarm reading one shape cannot be silently
    // migrated to the other.
    const record = (emitter: ReturnType<typeof createBufferedMetricEmitter>, mode: 'perEntry' | 'aggregated') => {
      emitter.record({
        metricName: 'W',
        dimensions: [{ name: 'Topic', value: 'a' }],
        emitDimensionlessCompanion: mode,
      });
      emitter.record({
        metricName: 'W',
        dimensions: [{ name: 'Topic', value: 'a' }],
        emitDimensionlessCompanion: mode,
      });
      emitter.record({
        metricName: 'W',
        dimensions: [{ name: 'Topic', value: 'b' }],
        emitDimensionlessCompanion: mode,
      });
    };

    const perEntry = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    record(perEntry, 'perEntry');
    await perEntry.flush();
    const perEntryCompanions = lastCommand().MetricData.filter((d) => d.Dimensions.length === 0);

    const aggregated = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    record(aggregated, 'aggregated');
    await aggregated.flush();
    const aggregatedCompanions = lastCommand().MetricData.filter((d) => d.Dimensions.length === 0);

    const sum = (xs: Array<{ Value: number }>) => xs.reduce((acc, d) => acc + d.Value, 0);
    expect(sum(perEntryCompanions)).toBe(sum(aggregatedCompanions));
    expect(perEntryCompanions.map((d) => d.Value).sort()).toEqual([1, 2]);
    expect(aggregatedCompanions.map((d) => d.Value)).toEqual([3]);
    // SampleCount, and therefore Average/Maximum/Minimum, differ.
    expect(perEntryCompanions).toHaveLength(2);
    expect(aggregatedCompanions).toHaveLength(1);
  });

  it('keeps aggregated companions separate per metric name', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({
      metricName: 'A',
      dimensions: [{ name: 'Topic', value: 't' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    emitter.record({
      metricName: 'B',
      dimensions: [{ name: 'Topic', value: 't' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    emitter.record({
      metricName: 'B',
      dimensions: [{ name: 'Topic', value: 'u' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    await emitter.flush();

    const companions = lastCommand().MetricData.filter((d) => d.Dimensions.length === 0);
    expect(companions).toHaveLength(2);
    expect(companions.find((d) => d.MetricName === 'A')?.Value).toBe(1);
    expect(companions.find((d) => d.MetricName === 'B')?.Value).toBe(2);
  });

  it('resolves a coalesced group that mixes modes to aggregated rather than double-publishing', async () => {
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'W', dimensions: [{ name: 'Kind', value: 'a' }], emitDimensionlessCompanion: true });
    emitter.record({
      metricName: 'W',
      dimensions: [{ name: 'Kind', value: 'a' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    await emitter.flush();

    const { MetricData } = lastCommand();
    expect(MetricData).toHaveLength(2);
    expect(MetricData.filter((d) => d.Dimensions.length === 0)).toHaveLength(1);
  });

  it('emits no aggregated companion for a metric that was never recorded in this flush', async () => {
    // The "skipped when zero" rule the sse counters depend on falls out of
    // buffering: nothing recorded means no entry means no companion, so the
    // namespace never collects zero points.
    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({
      metricName: 'A',
      dimensions: [{ name: 'Topic', value: 't' }],
      emitDimensionlessCompanion: 'aggregated',
    });
    await emitter.flush();

    const names = lastCommand().MetricData.map((d) => d.MetricName);
    expect(names.filter((n) => n === 'A')).toHaveLength(2);
    expect(names).not.toContain('B');
  });
});

describe('createBufferedMetricEmitter — caller-owned flush cadence and log prefix', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
  });

  it('arms no timer when flushIntervalMs is null', async () => {
    jest.useFakeTimers();
    try {
      const emitter = createBufferedMetricEmitter({
        namespace: 'WXYC/Test',
        flushIntervalMs: null,
        flushAtBufferSize: 10,
      });
      emitter.record({ metricName: 'Widgets' });

      jest.advanceTimersByTime(10 * 60_000);
      expect(mockSend).not.toHaveBeenCalled();

      await emitter.flush();
      expect(mockSend).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still auto-flushes on the size threshold when flushIntervalMs is null', async () => {
    const emitter = createBufferedMetricEmitter({
      namespace: 'WXYC/Test',
      flushIntervalMs: null,
      flushAtBufferSize: 3,
    });
    emitter.record({ metricName: 'Widgets' });
    emitter.record({ metricName: 'Widgets' });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(lastCommand().MetricData[0].Value).toBe(3);
  });

  it('uses the configured logPrefix on the swallowed-failure line', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSend.mockRejectedValue(new Error('CloudWatch unreachable'));

    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test', logPrefix: '[responseMetrics]' });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[responseMetrics] PutMetricData failed; dropping batch:',
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  it('falls back to [metrics:<namespace>] when no logPrefix is configured', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSend.mockRejectedValue(new Error('CloudWatch unreachable'));

    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[metrics:WXYC/Test] PutMetricData failed; dropping batch:',
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
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
