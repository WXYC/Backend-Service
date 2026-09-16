/**
 * CloudWatch metrics for the SSE server.
 *
 * Four metrics in the `WXYC/BackendService` namespace under the `SSE/`
 * prefix:
 *
 *   - `SSE/ClientCount` (gauge): live count of connected SSE clients, sampled
 *     once per interval. Emitted as a dimensioned series (per `Topic`) for
 *     dashboards / per-slice drill-down, and as a dimensionless companion
 *     series for alarm inputs. See the org-wide "CloudWatch Metric & Alarm
 *     Conventions" rule in `WXYC/CLAUDE.md`.
 *
 *   - `SSE/EventsBroadcast` (counter): one increment per call to
 *     `serverEventsMgr.broadcast(topic, ...)`, regardless of subscriber count.
 *     Dimensioned by `Topic`. Dashboard-only — no dimensionless companion.
 *
 *   - `SSE/BroadcastFailures` (counter): one increment per per-client write
 *     failure inside `broadcast()` / `dispatch()`. Dimensioned by `Topic` and
 *     also emitted as a dimensionless companion so an aggregate-failure-rate
 *     alarm can subscribe via the plain `Namespace`/`MetricName` form (the
 *     wxyc-canary post-mortem #13 pattern).
 *
 *   - `SSE/InsertSuppressed` (counter, BS#2131 review follow-up): one
 *     increment per flowsheet track INSERT that `filterMetadataInsert`
 *     (`../metadata-broadcast/metadata-broadcast.ts`) drops because its
 *     `add_time` is older than the age-guard threshold. Dimensioned by
 *     `Topic` (always `Topics.liveFs` today) plus a dimensionless companion —
 *     an unexpected spike is alarm-worthy: either the age-guard threshold is
 *     misconfigured (e.g. the `LIVE_FS_INSERT_MAX_AGE_HOURS=0` kill-switch
 *     hazard) or a large historical import is running. A silent *drop* in
 *     this metric during a known bulk import is the complementary failure
 *     mode (the guard stopped firing, e.g. on a schema change to `add_time`)
 *     but isn't something a single metric can distinguish from "no import is
 *     running" — see that file's docstring for the full caveat.
 *
 *   - `SSE/UpdateSuppressed` (counter, BS#2281 prerequisite): the UPDATE-path
 *     sibling of the above — one increment per terminal flowsheet track
 *     UPDATE that `filterMetadataUpdate` drops because its `add_time` is
 *     older than `LIVE_FS_UPDATE_MAX_AGE_HOURS`. Dimensioned by `Topic` plus a
 *     dimensionless companion. Expected to spike for the duration of a
 *     deliberate bulk UPDATE (`jobs/flowsheet-dj-name-scrub`,
 *     `jobs/flowsheet-metadata-backfill`) — that spike IS the guard working.
 *     A spike with no such job running means the threshold is misconfigured.
 *
 * Two companion rules, deliberately opposite, both load-bearing. The three
 * counters' companions carry the SUM across topics as a single datum
 * (`'aggregated'`, not the `'perEntry'` N + N shape `responseMetrics.ts`
 * ships) and are skipped entirely when the count is zero, so the namespace
 * isn't polluted with zero points that could invite a misconfigured alarm.
 * The gauge's companion is emitted on EVERY tick including `total === 0`, so
 * a "ClientCount unexpectedly 0" alarm has a continuous series to evaluate.
 *
 * Bounded sampling. Counter buffering, coalescing, the aggregated companions
 * and the swallow-on-failure live in `@wxyc/observability/metrics` as of
 * BS#2191; this module owns the metric names, the `Topic` dimension, the
 * companion decisions, the tick, and the opt-out. Counters flush on whichever
 * comes first: the periodic timer (default 60 s) or 100 buffered increments.
 * The emitter's own one-shot timer is switched off (`flushIntervalMs: null`)
 * because the `setInterval` below already owns the cadence and must flush
 * counters and sample the gauge on the SAME tick; a second, independently
 * phased timer would publish extra datapoints at a cadence no alarm `Period`
 * was sized for.
 *
 * The gauge stays out of the emitter on purpose. It has no `record()` call to
 * buffer — it is sampled from `snapshotFn` on the tick — and it is not
 * additive: the emitter coalesces by SUMMING, which is right for a counter
 * and wrong for two gauge samples of the same topic. Its unconditional
 * zero-total companion is also inexpressible in a "publish what was buffered"
 * emitter. Consequence: two `PutMetricData` calls per tick, issued
 * concurrently and failing/logging independently (`(counters)` vs `(gauges)`),
 * which is the pre-BS#2191 behaviour and the reason a broken snapshot source
 * cannot take the counters down with it. It also means two CloudWatch clients
 * in this module — the emitter's and the gauge path's. Two instances, one
 * construction: both are built by `createCloudWatchClient`
 * (`@wxyc/observability/metrics`), which pins the credential provider to the
 * EC2 instance role (BS#2533).
 *
 * Opt-out. `SSE_METRICS_DISABLED=true` short-circuits the module: no client
 * is created, no timer fires, and the `recordBroadcast` / `recordBroadcastFailure`
 * / `recordInsertSuppressed` / `recordUpdateSuppressed` entry points become no-ops. Required so CI and
 * local dev don't try to talk to CloudWatch.
 *
 * Failure handling. `PutMetricData` rejections are logged and swallowed; the
 * caller path (broadcast, gauge sample) is never blocked and the next tick
 * attempts a fresh send.
 */

import { PutMetricDataCommand, type CloudWatchClient, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import { createBufferedMetricEmitter, createCloudWatchClient } from '@wxyc/observability/metrics';

const NAMESPACE = 'WXYC/BackendService';
const METRIC_CLIENT_COUNT = 'SSE/ClientCount';
const METRIC_EVENTS_BROADCAST = 'SSE/EventsBroadcast';
const METRIC_BROADCAST_FAILURES = 'SSE/BroadcastFailures';
const METRIC_INSERT_SUPPRESSED = 'SSE/InsertSuppressed';
const METRIC_UPDATE_SUPPRESSED = 'SSE/UpdateSuppressed';

const DEFAULT_INTERVAL_MS = 60_000;
const FLUSH_AT_BUFFER_SIZE = 100;

type TopicCount = Map<string, number>;

let flushTimer: NodeJS.Timeout | null = null;
let cloudwatchClient: CloudWatchClient | null = null;
let snapshotFn: (() => TopicCount) | null = null;

function isDisabled(): boolean {
  return process.env.SSE_METRICS_DISABLED === 'true';
}

/**
 * Counter emitter. `FLUSH_AT_BUFFER_SIZE` counts total increments, not
 * distinct topics — the emitter buffers one point per `record()` call and
 * coalesces only at flush time, so `buffer.length` is exactly the
 * `bufferedTotal` this module used to track by hand.
 */
const counters = createBufferedMetricEmitter({
  namespace: NAMESPACE,
  flushIntervalMs: null,
  flushAtBufferSize: FLUSH_AT_BUFFER_SIZE,
  isDisabled,
  logPrefix: '[sse-metrics] (counters)',
});

/**
 * The gauge's own client. A second client INSTANCE, but not a second
 * credential decision: `createCloudWatchClient` (`@wxyc/observability/metrics`)
 * is the fleet's only construction site, and it pins the provider to the EC2
 * instance role (BS#2533/BS#2518). Constructing one here directly would leave
 * the gauge on the default chain, where `AWS_ACCESS_KEY_ID` outranks the role.
 */
function getClient(): CloudWatchClient {
  if (!cloudwatchClient) {
    cloudwatchClient = createCloudWatchClient();
  }
  return cloudwatchClient;
}

/** Record one broadcast event for the given topic. */
export function recordBroadcast(topic: string): void {
  // Dashboard-only: no alarm reads an aggregate EventsBroadcast, so no
  // companion. Adding one would double the cost and invite a misconfigured
  // alarm on a series nothing asked for.
  counters.record({
    metricName: METRIC_EVENTS_BROADCAST,
    dimensions: [{ name: 'Topic', value: topic }],
  });
}

/** Record one per-client broadcast write failure for the given topic. */
export function recordBroadcastFailure(topic: string): void {
  // Aggregated companion: one datum per flush carrying the sum across topics,
  // the alarm input PutMetricAlarm can't compute for itself.
  counters.record({
    metricName: METRIC_BROADCAST_FAILURES,
    dimensions: [{ name: 'Topic', value: topic }],
    emitDimensionlessCompanion: 'aggregated',
  });
}

/** Record one age-guard-suppressed flowsheet track INSERT for the given topic. */
export function recordInsertSuppressed(topic: string): void {
  counters.record({
    metricName: METRIC_INSERT_SUPPRESSED,
    dimensions: [{ name: 'Topic', value: topic }],
    emitDimensionlessCompanion: 'aggregated',
  });
}

/**
 * Record one age-guard-suppressed terminal flowsheet track UPDATE for the
 * given topic. Sibling of `recordInsertSuppressed`; kept as its own metric
 * rather than folded into `SSE/InsertSuppressed` because the two answer
 * different questions — a spike here means a bulk UPDATE is running (or
 * `LIVE_FS_UPDATE_MAX_AGE_HOURS` is misconfigured), which is a distinct
 * operational condition from a bulk import.
 */
export function recordUpdateSuppressed(topic: string): void {
  counters.record({
    metricName: METRIC_UPDATE_SUPPRESSED,
    dimensions: [{ name: 'Topic', value: topic }],
    emitDimensionlessCompanion: 'aggregated',
  });
}

function buildGaugeData(timestamp: Date): MetricDatum[] {
  if (!snapshotFn) return [];

  // The snapshot source is owned by the caller (e.g. `serverEventsMgr.getClientCountByTopic`).
  // A defensive guard here preserves the "metrics bookkeeping never escapes" contract — a
  // bug in the source must not blow up the periodic tick or leak as an unhandledRejection.
  let snapshot: TopicCount;
  try {
    snapshot = snapshotFn();
  } catch (err) {
    console.error('[sse-metrics] snapshot function threw; skipping gauge tick:', err);
    return [];
  }

  const data: MetricDatum[] = [];
  let total = 0;

  for (const [topic, count] of snapshot) {
    total += count;
    data.push({
      MetricName: METRIC_CLIENT_COUNT,
      Timestamp: timestamp,
      Unit: 'Count',
      Value: count,
      Dimensions: [{ Name: 'Topic', Value: topic }],
    });
  }

  // Dimensionless companion (alarm input) — always emitted, including total=0,
  // so a "ClientCount unexpectedly 0" alarm has a continuous series to evaluate.
  // This is the rule that keeps the gauge out of the buffered emitter: an
  // emitter publishes what was recorded, and a zero-total tick records nothing.
  data.push({
    MetricName: METRIC_CLIENT_COUNT,
    Timestamp: timestamp,
    Unit: 'Count',
    Value: total,
    Dimensions: [],
  });

  return data;
}

async function flushGauges(): Promise<void> {
  const timestamp = new Date();
  const data = buildGaugeData(timestamp);
  if (data.length === 0) return;

  try {
    await getClient().send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data }));
  } catch (err) {
    console.error('[sse-metrics] PutMetricData (gauges) failed; dropping batch:', err);
  }
}

async function tick(): Promise<void> {
  await Promise.all([counters.flush(), flushGauges()]);
}

/**
 * Starts the periodic metrics tick. Must be called once at app startup with
 * a snapshot function that returns the live client-count map keyed by topic.
 *
 * No-op when `SSE_METRICS_DISABLED=true`. Idempotent — calling twice does
 * not start a second timer (the second call updates the snapshot function).
 */
export function startSseMetrics(snapshot: () => TopicCount): void {
  snapshotFn = snapshot;
  if (isDisabled()) return;
  if (flushTimer) return;

  const interval = Number(process.env.SSE_METRICS_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  flushTimer = setInterval(() => {
    void tick();
  }, interval);
  flushTimer.unref?.();
}

/** Stops the metrics tick. Safe to call multiple times. */
export function stopSseMetrics(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/**
 * Test hook: clear all in-memory state and the singleton client. Only consumed
 * by tests/unit/services/sse-metrics.test.ts.
 */
export function __resetForTests(): void {
  stopSseMetrics();
  counters.reset();
  cloudwatchClient = null;
  snapshotFn = null;
}

/**
 * Test hook: force-flush both counters and gauges. Returns the promise so
 * tests can deterministically await the CloudWatch interactions.
 */
export function __flushForTests(): Promise<void> {
  return tick();
}
