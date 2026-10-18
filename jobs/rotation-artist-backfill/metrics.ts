/**
 * CloudWatch counters for the BS#1402 alert signals (BS#3401). The same
 * `not_found` / `lml_error` totals ride the Sentry totals span; these give
 * the alarms a non-span home before the spans go.
 *
 * Dimensionless on purpose: one job, so one series per metric, and the
 * alarm reads it through the plain Namespace/MetricName form.
 * `flushIntervalMs: null` because this is a one-shot job — a timer flush
 * could be lost at exit, so `emitBackfillCounters` flushes explicitly.
 */
import { createBufferedMetricEmitter } from '@wxyc/observability/metrics';

const emitter = createBufferedMetricEmitter({
  namespace: 'WXYC/RotationArtistBackfill',
  flushIntervalMs: null,
  isDisabled: () => process.env.ROTATION_ARTIST_BACKFILL_METRICS_DISABLED === 'true',
  logPrefix: '[rotation-artist-backfill metrics]',
});

/** Record both counters and await the PutMetricData round-trip. Failures are logged and swallowed by the emitter. */
export const emitBackfillCounters = async (totals: { not_found: number; lml_error: number }): Promise<void> => {
  emitter.record({ metricName: 'NotFound', value: totals.not_found });
  emitter.record({ metricName: 'LmlError', value: totals.lml_error });
  await emitter.flush();
};
