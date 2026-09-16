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
 * aggregate across dimensions the way `GetMetricData` can. The companion's
 * SHAPE is likewise the caller's choice (`DimensionlessCompanionMode`),
 * because the two shapes answer differently under every Statistic but `Sum`
 * and an existing alarm is already reading one of them.
 */

export interface MetricDimension {
  name: string;
  value: string;
}

/**
 * Shape of the dimensionless companion series.
 *
 * `'perEntry'` — every coalesced entry publishes its OWN companion carrying
 * that entry's value. N dimensioned datums produce N companions. The two
 * views are numerically identical under ANY Statistic (`Sum`, `Average`,
 * `Maximum`, `Minimum`, `SampleCount`), which is why it is the default and
 * what `emitDimensionlessCompanion: true` means.
 *
 * `'aggregated'` — ONE companion per `(metricName, unit)` per flush, carrying
 * the sum across every dimension slice. N dimensioned datums produce 1
 * companion.
 *
 * **The two agree under `Sum` and disagree under everything else.** With
 * per-topic values 2 and 1: `'perEntry'` publishes companions {2, 1}
 * (`Average` 1.5, `Maximum` 2, `SampleCount` 2); `'aggregated'` publishes {3}
 * (`Average` 3, `Maximum` 3, `SampleCount` 1). Choose `'aggregated'` only
 * when an alarm is already reading that shape — switching an existing metric
 * between the two silently rescales every non-`Sum` alarm on it.
 */
export type DimensionlessCompanionMode = 'perEntry' | 'aggregated';

export interface RecordMetricInput {
  metricName: string;
  /** Defaults to `[]` — a dimensionless metric (e.g. a simple counter/gauge). */
  dimensions?: MetricDimension[];
  /** Defaults to `1`. */
  value?: number;
  /** Defaults to `'Count'`. */
  unit?: StandardUnit;
  /**
   * Also emit a dimensionless `MetricDatum` alongside the dimensioned one —
   * the series a plain-form `Namespace`/`MetricName` alarm queries
   * (`PutMetricAlarm` rejects `SUM(SEARCH(...))` and other cross-dimension
   * aggregation expressions). Defaults to `false` (no companion); `true` is
   * `'perEntry'`. See `DimensionlessCompanionMode` for why the two modes are
   * not interchangeable.
   */
  emitDimensionlessCompanion?: boolean | DimensionlessCompanionMode;
}

export interface BufferedMetricEmitterOptions {
  /** CloudWatch namespace every `record()` call on this emitter publishes into. */
  namespace: string;
  /**
   * Flush interval in ms if the buffer never reaches `flushAtBufferSize`
   * first. Defaults to 30_000.
   *
   * `null` disables the emitter's own timer entirely, leaving `flush()` and
   * the size threshold as the only flush triggers. For a call site that
   * already owns a flush cadence — `apps/backend/services/sse/sse-metrics.ts`
   * runs a `setInterval` that must flush counters and sample a gauge on the
   * same tick — a second, independently-phased timer would publish extra
   * datapoints at a cadence the alarm's `Period` was not sized for.
   */
  flushIntervalMs?: number | null;
  /** Buffer size that triggers an immediate flush. Defaults to 10. */
  flushAtBufferSize?: number;
  /** Checked on every `record()` call; when true, the call is a no-op. Defaults to `() => false`. */
  isDisabled?: () => boolean;
  /**
   * Prefix on the swallow-on-failure log line
   * (`<logPrefix> PutMetricData failed; dropping batch:`). Defaults to
   * `[metrics:<namespace>]`. Call sites migrated off their own emitter pass
   * their historical prefix so existing log greps keep matching.
   */
  logPrefix?: string;
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
  companion: CompanionMode;
}

type CompanionMode = 'none' | DimensionlessCompanionMode;

const COMPANION_RANK: Record<CompanionMode, number> = { none: 0, perEntry: 1, aggregated: 2 };

function normalizeCompanion(input: boolean | DimensionlessCompanionMode | undefined): CompanionMode {
  if (input === undefined || input === false) return 'none';
  if (input === true) return 'perEntry';
  return input;
}

/**
 * Rank-merge rather than first-wins: if ANY record in a coalesced group asked
 * for the companion, the group's alarm-input series needs it — first-wins
 * would silently drop it whenever an opted-out record happened to land first.
 * A group that mixes the two modes resolves to `'aggregated'`, since emitting
 * both shapes would double-publish the same counts into one series; mixing
 * them under one metric name is a call-site bug either way.
 */
function mergeCompanion(a: CompanionMode, b: CompanionMode): CompanionMode {
  return COMPANION_RANK[a] >= COMPANION_RANK[b] ? a : b;
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
    logPrefix = `[metrics:${options.namespace}]`,
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
    if (flushIntervalMs === null) return;
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
        existing.companion = mergeCompanion(existing.companion, datum.companion);
      } else {
        coalesced.set(key, {
          metricName: datum.metricName,
          dimensions: datum.dimensions,
          unit: datum.unit,
          value: datum.value,
          companion: datum.companion,
        });
      }
    }

    const timestamp = new Date();
    const metricData: MetricDatum[] = [];
    // Aggregated companions are accumulated across the whole flush (one per
    // metricName + unit, summed over every dimension slice) and appended
    // after the dimensioned datums, so they can't be emitted inline.
    const aggregatedCompanions = new Map<string, { metricName: string; unit: StandardUnit; value: number }>();
    for (const entry of coalesced.values()) {
      metricData.push({
        MetricName: entry.metricName,
        Timestamp: timestamp,
        Unit: entry.unit,
        Value: entry.value,
        Dimensions: entry.dimensions.map((d) => ({ Name: d.name, Value: d.value })),
      });
      if (entry.companion === 'perEntry') {
        metricData.push({
          MetricName: entry.metricName,
          Timestamp: timestamp,
          Unit: entry.unit,
          Value: entry.value,
          Dimensions: [],
        });
      } else if (entry.companion === 'aggregated') {
        const key = `${entry.metricName}::${entry.unit}`;
        const running = aggregatedCompanions.get(key);
        if (running) running.value += entry.value;
        else aggregatedCompanions.set(key, { metricName: entry.metricName, unit: entry.unit, value: entry.value });
      }
    }
    for (const companion of aggregatedCompanions.values()) {
      metricData.push({
        MetricName: companion.metricName,
        Timestamp: timestamp,
        Unit: companion.unit,
        Value: companion.value,
        Dimensions: [],
      });
    }

    try {
      await getClient().send(
        new PutMetricDataCommand({
          Namespace: namespace,
          MetricData: metricData,
        })
      );
    } catch (err) {
      console.error(`${logPrefix} PutMetricData failed; dropping batch:`, err);
    }
  }

  function record(input: RecordMetricInput): void {
    if (isDisabled()) return;

    buffer.push({
      metricName: input.metricName,
      dimensions: input.dimensions ?? [],
      value: input.value ?? 1,
      unit: input.unit ?? 'Count',
      companion: normalizeCompanion(input.emitDimensionlessCompanion),
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
