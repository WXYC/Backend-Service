import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
  type StandardUnit,
} from '@aws-sdk/client-cloudwatch';

/**
 * Generic buffered CloudWatch metric emitter (BS#2169).
 *
 * Extracted from the machinery duplicated between
 * `apps/backend/middleware/responseMetrics.ts` (BS#845) and
 * `apps/backend/services/sse/sse-metrics.ts`: an in-memory buffer of
 * `(metricName, dimensions) -> count` entries, flushed on whichever comes
 * first — a periodic timer or a buffer-size threshold — with identical
 * `(metricName, dimensions)` pairs coalesced into a single summed
 * `MetricDatum` per flush. Each call site owns its own namespace, metric
 * names, dimension shape, and opt-out env var; this module owns only the
 * buffering/coalescing/flush/swallow-on-failure mechanics.
 *
 * **Ship as a subpath, never from the package barrel
 * (`@wxyc/observability`).** `src/index.ts` is loaded eagerly at Sentry
 * preload in both `apps/backend/instrument.ts` and `apps/auth/instrument.ts`
 * (`node --import ./dist/instrument.js`). Re-exporting an AWS-SDK-backed
 * emitter from that barrel would eagerly load `@aws-sdk/client-cloudwatch`
 * at process preload in both images. Import this file as
 * `@wxyc/observability/metrics` instead.
 *
 * Dimensioned + dimensionless companion is the caller's choice per call
 * (`emitDimensionlessCompanion`), not a package-wide default — see
 * `WXYC/CLAUDE.md`'s "CloudWatch Metric & Alarm Conventions": a companion is
 * for alarm inputs only, since CloudWatch's `PutMetricAlarm` cannot
 * aggregate across dimensions the way `GetMetricData` can.
 */

export interface MetricDimension {
  name: string;
  value: string;
}

export interface RecordMetricInput {
  metricName: string;
  /** Defaults to `[]` — a dimensionless metric (e.g. a simple counter/gauge). */
  dimensions?: MetricDimension[];
  /** Defaults to `1`. */
  value?: number;
  /** Defaults to `'Count'`. */
  unit?: StandardUnit;
  /**
   * Also emit a second, dimensionless `MetricDatum` with the same summed
   * value alongside the dimensioned one — the series a plain-form
   * `Namespace`/`MetricName` alarm queries (`PutMetricAlarm` rejects
   * `SUM(SEARCH(...))` and other cross-dimension aggregation expressions).
   * Defaults to `false`.
   */
  emitDimensionlessCompanion?: boolean;
}

export interface BufferedMetricEmitterOptions {
  /** CloudWatch namespace every `record()` call on this emitter publishes into. */
  namespace: string;
  /** Flush interval in ms if the buffer never reaches `flushAtBufferSize` first. Defaults to 30_000. */
  flushIntervalMs?: number;
  /** Buffer size that triggers an immediate flush. Defaults to 10. */
  flushAtBufferSize?: number;
  /** Checked on every `record()` call; when true, the call is a no-op. Defaults to `() => false`. */
  isDisabled?: () => boolean;
  /** Called (instead of `console.error`) when a flush's `PutMetricData` rejects. */
  onFlushError?: (error: unknown) => void;
}

export interface BufferedMetricEmitter {
  /** Buffers one metric point. No-op when `isDisabled()` returns true. */
  record(input: RecordMetricInput): void;
  /**
   * Forces an immediate flush of any buffered points, cancelling any pending
   * timer first. Returns the promise so callers (tests, graceful shutdown)
   * can await the CloudWatch round-trip deterministically.
   */
  flush(): Promise<void>;
  /** Clears buffered state, any pending timer, and the singleton CloudWatch client. */
  reset(): void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_FLUSH_AT_BUFFER_SIZE = 10;

interface BufferedDatum {
  metricName: string;
  dimensions: MetricDimension[];
  value: number;
  unit: StandardUnit;
  emitDimensionlessCompanion: boolean;
}

interface CoalescedEntry {
  metricName: string;
  dimensions: MetricDimension[];
  unit: StandardUnit;
  value: number;
  emitDimensionlessCompanion: boolean;
}

function coalesceKey(metricName: string, dimensions: MetricDimension[]): string {
  const dimensionKey = dimensions
    .map((d) => `${d.name}=${d.value}`)
    .sort()
    .join('&');
  return `${metricName}::${dimensionKey}`;
}

export function createBufferedMetricEmitter(options: BufferedMetricEmitterOptions): BufferedMetricEmitter {
  const {
    namespace,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    flushAtBufferSize = DEFAULT_FLUSH_AT_BUFFER_SIZE,
    isDisabled = () => false,
    onFlushError,
  } = options;

  let buffer: BufferedDatum[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let cloudwatchClient: CloudWatchClient | null = null;

  function getClient(): CloudWatchClient {
    if (!cloudwatchClient) {
      cloudwatchClient = new CloudWatchClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });
    }
    return cloudwatchClient;
  }

  function ensureFlushTimer(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushBuffer();
    }, flushIntervalMs);
    // Don't keep the event loop alive on its own.
    flushTimer.unref?.();
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0) return;
    const drained = buffer;
    buffer = [];

    const coalesced = new Map<string, CoalescedEntry>();
    for (const datum of drained) {
      const key = coalesceKey(datum.metricName, datum.dimensions);
      const existing = coalesced.get(key);
      if (existing) {
        existing.value += datum.value;
      } else {
        coalesced.set(key, {
          metricName: datum.metricName,
          dimensions: datum.dimensions,
          unit: datum.unit,
          value: datum.value,
          emitDimensionlessCompanion: datum.emitDimensionlessCompanion,
        });
      }
    }

    const timestamp = new Date();
    const metricData: MetricDatum[] = [];
    for (const entry of coalesced.values()) {
      metricData.push({
        MetricName: entry.metricName,
        Timestamp: timestamp,
        Unit: entry.unit,
        Value: entry.value,
        Dimensions: entry.dimensions.map((d) => ({ Name: d.name, Value: d.value })),
      });
      if (entry.emitDimensionlessCompanion) {
        metricData.push({
          MetricName: entry.metricName,
          Timestamp: timestamp,
          Unit: entry.unit,
          Value: entry.value,
          Dimensions: [],
        });
      }
    }

    try {
      await getClient().send(
        new PutMetricDataCommand({
          Namespace: namespace,
          MetricData: metricData,
        })
      );
    } catch (err) {
      if (onFlushError) {
        onFlushError(err);
      } else {
        console.error(`[metrics:${namespace}] PutMetricData failed; dropping batch:`, err);
      }
    }
  }

  function record(input: RecordMetricInput): void {
    if (isDisabled()) return;

    buffer.push({
      metricName: input.metricName,
      dimensions: input.dimensions ?? [],
      value: input.value ?? 1,
      unit: input.unit ?? 'Count',
      emitDimensionlessCompanion: input.emitDimensionlessCompanion ?? false,
    });

    if (buffer.length >= flushAtBufferSize) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      void flushBuffer();
      return;
    }
    ensureFlushTimer();
  }

  function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return flushBuffer();
  }

  function reset(): void {
    buffer = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    cloudwatchClient = null;
  }

  return { record, flush, reset };
}
