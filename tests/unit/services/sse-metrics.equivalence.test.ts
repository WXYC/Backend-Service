/**
 * Before/after equivalence for the five SSE metrics (BS#2191).
 *
 * `tests/fixtures/metric-emitter-baseline.json` was captured by running the
 * PRE-migration `apps/backend/services/sse/sse-metrics.ts` — the one with its
 * own four `Map<topic, count>` buffers, its own `bufferedTotal` threshold and
 * its own hand-rolled companions — against the scenario drivers in
 * `tests/utils/metric-emitter-scenarios.ts`. This suite replays the identical
 * scenarios through the migrated module and asserts the published
 * `PutMetricDataCommand` input is unchanged, per metric.
 *
 * The canonical form pins the number of `PutMetricData` calls (so the
 * counters/gauges split survives), the namespace, and per metric the exact
 * (Unit, Value, Dimensions) multiset including the companion. It deliberately
 * does not pin datum order within a call, nor which of the two concurrent
 * calls is issued first: CloudWatch treats `MetricData` as a set of
 * independently-timestamped points. Both of those DID change — counters are
 * now grouped by first-record order rather than by metric, and the gauge call
 * is now constructed before the counter call because the emitter's flush
 * starts in a microtask — and neither is observable in CloudWatch.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutMetricDataCommand: mockPutMetricDataCommand,
}));

import * as sseMetrics from '../../../apps/backend/services/sse/sse-metrics';
import baseline from '../../fixtures/metric-emitter-baseline.json';
import {
  canonicalize,
  sseMetricsScenarios,
  type CapturedCall,
  type CanonicalScenarioResult,
} from '../../utils/metric-emitter-scenarios';

const expected = baseline.scenarios as unknown as Record<string, CanonicalScenarioResult>;

function calls(): CapturedCall[] {
  return mockPutMetricDataCommand.mock.calls.map((c) => c[0] as CapturedCall);
}

async function runScenario(name: string): Promise<CanonicalScenarioResult> {
  const scenario = sseMetricsScenarios.find((s) => s.name === name);
  await scenario.run(sseMetrics);
  return canonicalize(calls());
}

describe('sse-metrics — published MetricDatum is unchanged by the BS#2191 migration', () => {
  const originalDisabled = process.env.SSE_METRICS_DISABLED;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    delete process.env.SSE_METRICS_DISABLED;
    sseMetrics.__resetForTests();
  });

  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.SSE_METRICS_DISABLED;
    else process.env.SSE_METRICS_DISABLED = originalDisabled;
    sseMetrics.__resetForTests();
  });

  it.each(sseMetricsScenarios.map((s) => [s.name] as const))('%s', async (name) => {
    expect(expected[name]).toBeDefined();
    expect(await runScenario(name)).toEqual(expected[name]);
  });

  it('keeps counters and gauges in two independent PutMetricData calls', async () => {
    // The split is why a broken snapshot source cannot take the counters down
    // with it, and why the two failure paths log separately. Collapsing them
    // into one call would still satisfy a per-metric comparison.
    const result = await runScenario('sse/all-four-counters-plus-gauge');
    expect(result.putMetricDataCalls).toBe(2);
    const gaugeCall = result.callSignatures.find((sig) => sig.includes('SSE/ClientCount'));
    expect(gaugeCall).toBe('SSE/ClientCount,SSE/ClientCount,SSE/ClientCount');
    expect(result.callSignatures.filter((sig) => sig.includes('SSE/ClientCount'))).toHaveLength(1);
  });
});

describe('sse-metrics — the companion decisions are pinned per metric, not in aggregate', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    delete process.env.SSE_METRICS_DISABLED;
    sseMetrics.__resetForTests();
  });

  afterEach(() => sseMetrics.__resetForTests());

  it("ships the counters' companions as 'aggregated' (N + 1 summed), not 'perEntry' (N + N)", async () => {
    // Values 2 and 1 across two topics. N + 1 publishes one companion of 3;
    // N + N would publish two of {2, 1}. Both sum to 3, so only a per-datum
    // assertion catches a switch — and `SSE/BroadcastFailures` is a live alarm
    // input whose Average, Maximum and SampleCount would all move.
    const { byMetric } = await runScenario('sse/broadcast-failures-two-topics');
    const data = byMetric['SSE/BroadcastFailures'];
    const dimensioned = data.filter((d) => d.Dimensions.length > 0);
    const dimensionless = data.filter((d) => d.Dimensions.length === 0);
    expect(dimensioned.map((d) => d.Value).sort()).toEqual([1, 2]);
    expect(dimensionless).toHaveLength(1);
    expect(dimensionless[0].Value).toBe(3);
  });

  it.each([
    ['SSE/InsertSuppressed', 'sse/insert-suppressed-two-topics', 3],
    ['SSE/UpdateSuppressed', 'sse/update-suppressed-two-topics', 4],
  ])('%s carries exactly one aggregated companion', async (metric, scenario, total) => {
    const { byMetric } = await runScenario(scenario);
    const dimensionless = byMetric[metric].filter((d) => d.Dimensions.length === 0);
    expect(dimensionless).toHaveLength(1);
    expect(dimensionless[0].Value).toBe(total);
  });

  it('ships EventsBroadcast dimensioned-only — adding a companion here would be a regression', async () => {
    const { byMetric } = await runScenario('sse/events-broadcast-two-topics');
    const data = byMetric['SSE/EventsBroadcast'];
    expect(data).toHaveLength(2);
    expect(data.filter((d) => d.Dimensions.length === 0)).toHaveLength(0);
    for (const datum of data) {
      expect(datum.Dimensions.map((d) => d.Name)).toEqual(['Topic']);
    }
  });

  it('skips the counter companions entirely when nothing was suppressed or failed', async () => {
    // Opposite rule to the gauge below: a zero here would pollute the
    // namespace and invite a misconfigured alarm.
    const { byMetric } = await runScenario('sse/events-broadcast-two-topics');
    expect(byMetric['SSE/BroadcastFailures']).toBeUndefined();
    expect(byMetric['SSE/InsertSuppressed']).toBeUndefined();
    expect(byMetric['SSE/UpdateSuppressed']).toBeUndefined();
  });

  it('emits the ClientCount companion unconditionally, including a zero total', async () => {
    // Opposite rule to the counters above: the alarm needs a continuous
    // series, so the zero point is the signal rather than noise. This is the
    // shape a buffered emitter cannot express, and the reason the gauge tick
    // stayed local.
    const { byMetric } = await runScenario('sse/gauge-only-empty-snapshot-emits-zero-companion');
    const data = byMetric['SSE/ClientCount'];
    expect(data).toHaveLength(1);
    expect(data[0].Dimensions).toEqual([]);
    expect(data[0].Value).toBe(0);
  });
});
