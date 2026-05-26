/**
 * CloudWatch metrics for the SSE server.
 *
 * Three metrics in the `WXYC/BackendService` namespace under the `SSE/`
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
 * Bounded sampling. Counters live in an in-memory `Map<topic, count>` and
 * flush on whichever comes first: the periodic timer (default 60 s) or when
 * the total buffered count exceeds `FLUSH_AT_BUFFER_SIZE`. ClientCount is a
 * gauge — sampled on the same timer tick.
 *
 * Opt-out. `SSE_METRICS_DISABLED=true` short-circuits the module: no client
 * is created, no timer fires, and the `recordBroadcast` / `recordBroadcastFailure`
 * entry points become no-ops. Required so CI and local dev don't try to talk
 * to CloudWatch.
 *
 * Failure handling. `PutMetricData` rejections are logged and swallowed; the
 * caller path (broadcast, gauge sample) is never blocked and the next tick
 * attempts a fresh send.
 */

import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from '@aws-sdk/client-cloudwatch';

const NAMESPACE = 'WXYC/BackendService';
const METRIC_CLIENT_COUNT = 'SSE/ClientCount';
const METRIC_EVENTS_BROADCAST = 'SSE/EventsBroadcast';
const METRIC_BROADCAST_FAILURES = 'SSE/BroadcastFailures';

const DEFAULT_INTERVAL_MS = 60_000;
const FLUSH_AT_BUFFER_SIZE = 100;

type TopicCount = Map<string, number>;

let broadcastBuffer: TopicCount = new Map();
let failureBuffer: TopicCount = new Map();
let bufferedTotal = 0;
let flushTimer: NodeJS.Timeout | null = null;
let cloudwatchClient: CloudWatchClient | null = null;
let snapshotFn: (() => TopicCount) | null = null;

function isDisabled(): boolean {
  return process.env.SSE_METRICS_DISABLED === 'true';
}

function getClient(): CloudWatchClient {
  if (!cloudwatchClient) {
    cloudwatchClient = new CloudWatchClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return cloudwatchClient;
}

function incrementTopic(map: TopicCount, topic: string): void {
  map.set(topic, (map.get(topic) ?? 0) + 1);
}

/** Record one broadcast event for the given topic. */
export function recordBroadcast(topic: string): void {
  if (isDisabled()) return;
  incrementTopic(broadcastBuffer, topic);
  bufferedTotal += 1;
  if (bufferedTotal >= FLUSH_AT_BUFFER_SIZE) {
    void flushCounters();
  }
}

/** Record one per-client broadcast write failure for the given topic. */
export function recordBroadcastFailure(topic: string): void {
  if (isDisabled()) return;
  incrementTopic(failureBuffer, topic);
  bufferedTotal += 1;
  if (bufferedTotal >= FLUSH_AT_BUFFER_SIZE) {
    void flushCounters();
  }
}

function buildCounterData(timestamp: Date): MetricDatum[] {
  const data: MetricDatum[] = [];

  for (const [topic, count] of broadcastBuffer) {
    data.push({
      MetricName: METRIC_EVENTS_BROADCAST,
      Timestamp: timestamp,
      Unit: 'Count',
      Value: count,
      Dimensions: [{ Name: 'Topic', Value: topic }],
    });
  }

  for (const [topic, count] of failureBuffer) {
    data.push({
      MetricName: METRIC_BROADCAST_FAILURES,
      Timestamp: timestamp,
      Unit: 'Count',
      Value: count,
      Dimensions: [{ Name: 'Topic', Value: topic }],
    });
  }
  // Dimensionless companion for the aggregate-failure alarm input — PutMetricAlarm
  // can't aggregate across dimensions. Skipped when zero so the namespace isn't
  // polluted with zero points that could invite a misconfigured alarm.
  if (failureBuffer.size > 0) {
    let total = 0;
    for (const count of failureBuffer.values()) total += count;
    data.push({
      MetricName: METRIC_BROADCAST_FAILURES,
      Timestamp: timestamp,
      Unit: 'Count',
      Value: total,
      Dimensions: [],
    });
  }

  return data;
}

function buildGaugeData(timestamp: Date): MetricDatum[] {
  if (!snapshotFn) return [];
  const snapshot = snapshotFn();
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
  data.push({
    MetricName: METRIC_CLIENT_COUNT,
    Timestamp: timestamp,
    Unit: 'Count',
    Value: total,
    Dimensions: [],
  });

  return data;
}

async function flushCounters(): Promise<void> {
  if (broadcastBuffer.size === 0 && failureBuffer.size === 0) return;

  const timestamp = new Date();
  const data = buildCounterData(timestamp);

  broadcastBuffer = new Map();
  failureBuffer = new Map();
  bufferedTotal = 0;

  if (data.length === 0) return;

  try {
    await getClient().send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data }));
  } catch (err) {
    console.error('[sse-metrics] PutMetricData (counters) failed; dropping batch:', err);
  }
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
  await Promise.all([flushCounters(), flushGauges()]);
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
  broadcastBuffer = new Map();
  failureBuffer = new Map();
  bufferedTotal = 0;
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
