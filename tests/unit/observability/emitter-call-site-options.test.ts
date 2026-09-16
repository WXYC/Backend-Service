/**
 * Pins the emitter options each call site passes (BS#2191).
 *
 * The migration's acceptance criterion says flush cadence and buffer-size
 * thresholds are unchanged per module, and the equivalence suites cannot
 * enforce it: they drive records and inspect the published `MetricDatum`, so
 * they are blind to *when* a flush happens. Every one of these is a silent
 * regression against the full 544-suite run without this file —
 *
 *   - `responseMetrics` 30_000 -> 300_000, or 10 -> 5
 *   - `sse-metrics` 100 -> 50
 *   - `sse-metrics` losing `flushIntervalMs: null` entirely
 *
 * — and the last is the one that matters. Without it the emitter arms its own
 * 30 s timer, so counter datapoints publish on a second, independently-phased
 * cadence alongside the module's own 60 s `setInterval` tick. A changed flush
 * cadence changes the timestamp distribution of published datapoints, which
 * changes what an alarm's `Period`/`EvaluationPeriods` sees — the module
 * docstring and `docs/env-vars.md` both call the single cadence load-bearing.
 *
 * Asserts the options object rather than the source text so a refactor that
 * moves the constants around still has to preserve the resolved values.
 */
import { describe, it, expect, jest } from '@jest/globals';

interface CapturedOptions {
  namespace: string;
  flushIntervalMs?: number | null;
  flushAtBufferSize?: number;
  logPrefix?: string;
  isDisabled?: () => boolean;
}

const captured: CapturedOptions[] = [];

jest.mock('@wxyc/observability/metrics', () => ({
  createBufferedMetricEmitter: (options: CapturedOptions) => {
    captured.push(options);
    return { record: jest.fn(), flush: jest.fn(), reset: jest.fn() };
  },
}));

// Imported for side effect: both modules build their emitter at module scope,
// so the options are captured on import.
import '../../../apps/backend/middleware/responseMetrics';
import '../../../apps/backend/services/sse/sse-metrics';

function optionsFor(logPrefix: string): CapturedOptions {
  const match = captured.find((o) => o.logPrefix === logPrefix);
  if (!match) {
    throw new Error(
      `no emitter was created with logPrefix ${logPrefix}; saw ${JSON.stringify(captured.map((o) => o.logPrefix))}`
    );
  }
  return match;
}

describe('emitter call-site options (BS#2191)', () => {
  it('responseMetrics keeps its 30 s / 10-point cadence', () => {
    const options = optionsFor('[responseMetrics]');

    expect(options.namespace).toBe('WXYC/BackendService');
    expect(options.flushIntervalMs).toBe(30_000);
    expect(options.flushAtBufferSize).toBe(10);
  });

  /**
   * `null`, not merely "not 30_000": the module owns its own 60 s
   * `setInterval` and the emitter must contribute no second timer. An
   * `undefined` here would silently accept the emitter's 30 s default.
   */
  it('sse-metrics counters disable the emitter timer and keep the 100-increment threshold', () => {
    const options = optionsFor('[sse-metrics] (counters)');

    expect(options.namespace).toBe('WXYC/BackendService');
    expect(options.flushIntervalMs).toBeNull();
    expect(options.flushAtBufferSize).toBe(100);
  });

  it('wires each module its own opt-out env var by name', () => {
    const response = optionsFor('[responseMetrics]');
    const sse = optionsFor('[sse-metrics] (counters)');

    const original = {
      mutation: process.env.MUTATION_4XX_METRICS_DISABLED,
      sse: process.env.SSE_METRICS_DISABLED,
    };
    try {
      delete process.env.MUTATION_4XX_METRICS_DISABLED;
      delete process.env.SSE_METRICS_DISABLED;
      expect(response.isDisabled?.()).toBe(false);
      expect(sse.isDisabled?.()).toBe(false);

      process.env.MUTATION_4XX_METRICS_DISABLED = 'true';
      process.env.SSE_METRICS_DISABLED = 'true';
      expect(response.isDisabled?.()).toBe(true);
      expect(sse.isDisabled?.()).toBe(true);
    } finally {
      if (original.mutation === undefined) delete process.env.MUTATION_4XX_METRICS_DISABLED;
      else process.env.MUTATION_4XX_METRICS_DISABLED = original.mutation;
      if (original.sse === undefined) delete process.env.SSE_METRICS_DISABLED;
      else process.env.SSE_METRICS_DISABLED = original.sse;
    }
  });
});
