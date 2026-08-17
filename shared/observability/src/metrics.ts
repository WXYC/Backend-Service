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

// One shape for both the raw buffer and the coalesced map: coalescing sums
// values within a key, it doesn't change what a point carries.
interface MetricPoint {
  metricName: string;
  dimensions: MetricDimension[];
  value: number;
  unit: StandardUnit;
  emitDimensionlessCompanion: boolean;
}

// `unit` is part of the key, not just carried on the entry. Two records with
// the same metric name and dimensions but different units are different
// series, and summing them would publish one datum whose value is the sum of
// (say) 250 milliseconds and 1 count, stamped with whichever unit happened to
// arrive first. Inert for a single-unit call site; a real defect the moment a
// second consumer of this shared package records more than one unit under a
// name.
function coalesceKey(metricName: string, dimensions: MetricDimension[], unit: StandardUnit): string {
  const dimensionKey = dimensions
    .map((d) => `${d.name}=${d.value}`)
    .sort()
    .join('&');
  return `${metricName}::${unit}::${dimensionKey}`;
}

export function createBufferedMetricEmitter(options: BufferedMetricEmitterOptions): BufferedMetricEmitter {
  const {
    namespace,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    flushAtBufferSize = DEFAULT_FLUSH_AT_BUFFER_SIZE,
    isDisabled = () => false,
  } = options;

  let buffer: MetricPoint[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let cloudwatchClient: CloudWatchClient | null = null;
  // The PutMetricData round-trip currently in flight, if any. `record()` and
  // the interval timer both kick a flush without awaiting it, and both drain
  // `buffer` synchronously — so without this handle, a subsequent `flush()`
  // would see an empty buffer and resolve immediately while the send is still
  // pending, breaking the "await the CloudWatch round-trip deterministically"
  // contract this interface documents. A shutdown hook awaiting `flush()`
  // would exit before the batch landed.
  let inFlight: Promise<void> | null = null;

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
      void startFlush();
    }, flushIntervalMs);
    // Don't keep the event loop alive on its own.
    flushTimer.unref?.();
  }

  /**
   * Runs a flush and publishes its promise as `inFlight` for the duration, so
   * a concurrent `flush()` can join it rather than resolving early against an
   * already-drained buffer. Chains onto any existing in-flight send so two
   * overlapping flushes stay ordered and `flush()` awaits both.
   */
  function startFlush(): Promise<void> {
    const previous = inFlight ?? Promise.resolve();
    const current = previous.then(flushBuffer);
    inFlight = current;
    void current.finally(() => {
      // Only clear if no later flush has since taken the slot.
      if (inFlight === current) inFlight = null;
    });
    return current;
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0) return;
    const drained = buffer;
    buffer = [];

    const coalesced = new Map<string, MetricPoint>();
    for (const datum of drained) {
      const key = coalesceKey(datum.metricName, datum.dimensions, datum.unit);
      const existing = coalesced.get(key);
      if (existing) {
        existing.value += datum.value;
        // OR rather than first-wins: if ANY record in a coalesced group asked
        // for the dimensionless companion, the group's alarm-input series
        // needs it. First-wins would silently drop the companion whenever an
        // opted-out record happened to land first.
        existing.emitDimensionlessCompanion ||= datum.emitDimensionlessCompanion;
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
      console.error(`[metrics:${namespace}] PutMetricData failed; dropping batch:`, err);
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
      void startFlush();
      return;
    }
    ensureFlushTimer();
  }

  function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // startFlush() chains onto any in-flight send, so the returned promise
    // covers both the pending round-trip and anything still buffered.
    return startFlush();
  }

  function reset(): void {
    buffer = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    inFlight = null;
    cloudwatchClient = null;
  }

  return { record, flush, reset };
}
