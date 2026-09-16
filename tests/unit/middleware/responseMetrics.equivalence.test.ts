/**
 * Before/after equivalence for `MutationClientError` (BS#2191).
 *
 * `tests/fixtures/metric-emitter-baseline.json` was captured by running the
 * PRE-migration `apps/backend/middleware/responseMetrics.ts` (the one that
 * carried its own buffer, its own NUL-separated coalesce key, and its own
 * CloudWatch client) against the scenario drivers in
 * `tests/utils/metric-emitter-scenarios.ts`. This suite replays the identical
 * scenarios through the migrated module and asserts the published
 * `PutMetricDataCommand` input is unchanged — per metric, not in aggregate.
 *
 * What the canonical form pins: the number of `PutMetricData` calls, the
 * namespace, and per metric name the exact (Unit, Value, Dimensions) multiset,
 * including presence, absence and value of the dimensionless companion. What
 * it deliberately does not pin: the order of datums inside one call, since
 * CloudWatch treats `MetricData` as a set of independently-timestamped points.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutMetricDataCommand: mockPutMetricDataCommand,
}));

import * as responseMetrics from '../../../apps/backend/middleware/responseMetrics';
import baseline from '../../fixtures/metric-emitter-baseline.json';
import {
  canonicalize,
  responseMetricsScenarios,
  type CapturedCall,
  type CanonicalScenarioResult,
} from '../../utils/metric-emitter-scenarios';

const expected = baseline.scenarios as unknown as Record<string, CanonicalScenarioResult>;

function calls(): CapturedCall[] {
  return mockPutMetricDataCommand.mock.calls.map((c) => c[0] as CapturedCall);
}

describe('responseMetrics — published MetricDatum is unchanged by the BS#2191 migration', () => {
  const originalDisabled = process.env.MUTATION_4XX_METRICS_DISABLED;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    delete process.env.MUTATION_4XX_METRICS_DISABLED;
    responseMetrics.__resetForTests();
  });

  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.MUTATION_4XX_METRICS_DISABLED;
    else process.env.MUTATION_4XX_METRICS_DISABLED = originalDisabled;
    responseMetrics.__resetForTests();
  });

  it.each(responseMetricsScenarios.map((s) => [s.name, s] as const))('%s', async (name, scenario) => {
    expect(expected[name]).toBeDefined();
    await scenario.run(responseMetrics);
    expect(canonicalize(calls())).toEqual(expected[name]);
  });

  it('the fixture it checks against really does carry the N + N companion shape', () => {
    // Guards the guard: an equivalence suite compared against an empty or
    // companion-less fixture would pass while the companion disappeared.
    const single = expected['responseMetrics/single-403-post-flowsheet'].byMetric.MutationClientError;
    expect(single.filter((d) => d.Dimensions.length === 0)).toHaveLength(1);
    expect(single.filter((d) => d.Dimensions.length > 0)).toHaveLength(1);

    const twoKeys = expected['responseMetrics/two-distinct-keys'].byMetric.MutationClientError;
    expect(
      twoKeys
        .filter((d) => d.Dimensions.length === 0)
        .map((d) => d.Value)
        .sort()
    ).toEqual([1, 2]);
    expect(
      twoKeys
        .filter((d) => d.Dimensions.length > 0)
        .map((d) => d.Value)
        .sort()
    ).toEqual([1, 2]);
  });
});

describe("responseMetrics — the companion flag's effect is pinned, not just its presence", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    delete process.env.MUTATION_4XX_METRICS_DISABLED;
    responseMetrics.__resetForTests();
  });

  afterEach(() => responseMetrics.__resetForTests());

  it("ships 'perEntry' (N + N), never the emitter's 'aggregated' N + 1 shape", async () => {
    // Under `Sum` the two are indistinguishable, so only a per-datum assertion
    // catches a silent switch. Three slices with values 2, 1, 1: N + N gives
    // three companions valued {2, 1, 1}; N + 1 would give one valued {4}, and
    // the canary's MutationClientErrorSurgeAlarm would keep reporting the same
    // Sum while Average, Maximum and SampleCount all changed underneath it.
    const scenario = responseMetricsScenarios.find(
      (s) => s.name === 'responseMetrics/four-distinct-keys-mixed-statuses'
    );
    await scenario.run(responseMetrics);

    const { byMetric } = canonicalize(calls());
    const data = byMetric.MutationClientError;
    const dimensioned = data.filter((d) => d.Dimensions.length > 0);
    const dimensionless = data.filter((d) => d.Dimensions.length === 0);
    expect(dimensioned).toHaveLength(4);
    expect(dimensionless).toHaveLength(4);
    expect(dimensionless.map((d) => d.Value).sort()).toEqual(dimensioned.map((d) => d.Value).sort());
    expect(dimensionless.map((d) => d.Value).sort()).toEqual([1, 1, 1, 2]);
    // Every dimensioned datum carries both dimension names, in this order.
    for (const datum of dimensioned) {
      expect(datum.Dimensions.map((d) => d.Name)).toEqual(['Route', 'StatusCode']);
    }
  });
});
