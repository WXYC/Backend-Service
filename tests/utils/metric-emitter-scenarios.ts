/**
 * Shared scenario drivers + canonicalizer for the BS#2191 before/after
 * equivalence check on the two `apps/backend` CloudWatch emitters.
 *
 * The point of this file is that one set of inputs drives BOTH the
 * pre-migration modules (captured once into
 * `tests/fixtures/metric-emitter-baseline.json`) and the post-migration ones
 * (`tests/unit/observability/metric-emitter-equivalence.test.ts`), so the
 * "published metrics are byte-identical" claim is executed rather than
 * asserted in prose.
 */
import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';

export interface CapturedDatum {
  Namespace: string;
  MetricName: string;
  Unit: string;
  Value: number;
  Dimensions: Array<{ Name: string; Value: string }>;
}

export interface CapturedCall {
  Namespace: string;
  MetricData: Array<{
    MetricName: string;
    Unit: string;
    Value: number;
    Dimensions: Array<{ Name: string; Value: string }>;
    Timestamp?: unknown;
  }>;
}

/**
 * Per-metric canonical form of everything a scenario published.
 *
 * Deliberately order-independent within a metric and across the
 * `PutMetricData` calls of one tick: CloudWatch treats `MetricData` as a set
 * of independently-timestamped datums, so datum order inside a call — and the
 * order of two concurrent calls — is not part of the published shape. What IS
 * pinned: the number of `PutMetricData` calls (the sse counters/gauges split),
 * the namespace, and per metric the exact (Unit, Value, Dimensions) multiset,
 * including presence/absence/value of the dimensionless companion.
 */
export interface CanonicalScenarioResult {
  putMetricDataCalls: number;
  /** One entry per call: the sorted multiset of metric names it carried. Sorted across calls. */
  callSignatures: string[];
  byMetric: Record<string, CapturedDatum[]>;
}

function datumKey(d: CapturedDatum): string {
  return JSON.stringify([d.Namespace, d.Unit, d.Value, d.Dimensions]);
}

export function canonicalize(calls: CapturedCall[]): CanonicalScenarioResult {
  const byMetric: Record<string, CapturedDatum[]> = {};
  for (const call of calls) {
    for (const datum of call.MetricData) {
      const flat: CapturedDatum = {
        Namespace: call.Namespace,
        MetricName: datum.MetricName,
        Unit: datum.Unit,
        Value: datum.Value,
        Dimensions: datum.Dimensions,
      };
      (byMetric[datum.MetricName] ??= []).push(flat);
    }
  }
  for (const name of Object.keys(byMetric)) {
    byMetric[name].sort((a, b) => datumKey(a).localeCompare(datumKey(b)));
  }
  const callSignatures = calls
    .map((call) =>
      call.MetricData.map((d) => d.MetricName)
        .sort()
        .join(',')
    )
    .sort();
  return {
    putMetricDataCalls: calls.length,
    callSignatures,
    byMetric: Object.fromEntries(
      Object.keys(byMetric)
        .sort()
        .map((k) => [k, byMetric[k]])
    ),
  };
}

export interface ResponseMetricsModule {
  responseMetricsMiddleware(req: Request, res: Response, next: NextFunction): void;
  __resetForTests(): void;
  __flushForTests(): Promise<void>;
}

export interface SseMetricsModule {
  recordBroadcast(topic: string): void;
  recordBroadcastFailure(topic: string): void;
  recordInsertSuppressed(topic: string): void;
  recordUpdateSuppressed(topic: string): void;
  startSseMetrics(snapshot: () => Map<string, number>): void;
  stopSseMetrics(): void;
  __resetForTests(): void;
  __flushForTests(): Promise<void>;
}

interface MockResponse extends EventEmitter {
  statusCode: number;
}

function makeReq(method: string, originalUrl: string): Request {
  return { method, originalUrl } as unknown as Request;
}

function makeRes(statusCode: number): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.statusCode = statusCode;
  return res;
}

function fire(mod: ResponseMetricsModule, method: string, url: string, status: number): void {
  const req = makeReq(method, url);
  const res = makeRes(status);
  mod.responseMetricsMiddleware(req, res as unknown as Response, () => {});
  res.emit('finish');
}

/** Lets a size-triggered flush that was kicked off without `await` settle. */
function yieldToFlush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface Scenario<M> {
  name: string;
  run(mod: M): Promise<void>;
}

/**
 * `MutationClientError` scenarios. Covers the single datum, coalescing,
 * multiple distinct coalesce keys in one flush (the N + N companion shape),
 * and the size-threshold auto-flush at 10.
 */
export const responseMetricsScenarios: Array<Scenario<ResponseMetricsModule>> = [
  {
    name: 'responseMetrics/single-403-post-flowsheet',
    async run(mod) {
      fire(mod, 'POST', '/flowsheet/', 403);
      await mod.__flushForTests();
    },
  },
  {
    name: 'responseMetrics/coalesced-three-identical',
    async run(mod) {
      for (let i = 0; i < 3; i += 1) fire(mod, 'POST', '/flowsheet/', 403);
      await mod.__flushForTests();
    },
  },
  {
    name: 'responseMetrics/two-distinct-keys',
    async run(mod) {
      fire(mod, 'POST', '/flowsheet/', 403);
      fire(mod, 'POST', '/flowsheet/', 403);
      fire(mod, 'PATCH', '/flowsheet/play-order', 409);
      await mod.__flushForTests();
    },
  },
  {
    name: 'responseMetrics/four-distinct-keys-mixed-statuses',
    async run(mod) {
      fire(mod, 'POST', '/flowsheet/', 403);
      fire(mod, 'POST', '/flowsheet/', 409);
      fire(mod, 'DELETE', '/flowsheet/', 404);
      fire(mod, 'PATCH', '/flowsheet/play-order', 400);
      fire(mod, 'PATCH', '/flowsheet/play-order', 400);
      await mod.__flushForTests();
    },
  },
  {
    name: 'responseMetrics/size-threshold-auto-flush-at-10',
    async run(mod) {
      for (let i = 0; i < 10; i += 1) fire(mod, 'DELETE', '/flowsheet/', 409);
      await yieldToFlush();
    },
  },
  {
    name: 'responseMetrics/out-of-scope-requests-publish-nothing',
    async run(mod) {
      fire(mod, 'POST', '/flowsheet/', 200);
      fire(mod, 'GET', '/library/release/123', 403);
      fire(mod, 'POST', '/djs/foo', 404);
      fire(mod, 'POST', '/flowsheet/', 500);
      await mod.__flushForTests();
    },
  },
];

/**
 * SSE scenarios. Covers each counter's companion decision (EventsBroadcast has
 * none; the three others carry an aggregated one), the gauge's unconditional
 * companion including the zero-total tick, the counters/gauges call split, and
 * the 100-increment size threshold.
 */
export const sseMetricsScenarios: Array<Scenario<SseMetricsModule>> = [
  {
    name: 'sse/events-broadcast-two-topics',
    async run(mod) {
      mod.recordBroadcast('live-fs-topic');
      mod.recordBroadcast('live-fs-topic');
      mod.recordBroadcast('test-topic');
      await mod.__flushForTests();
    },
  },
  {
    name: 'sse/broadcast-failures-two-topics',
    async run(mod) {
      mod.recordBroadcastFailure('live-fs-topic');
      mod.recordBroadcastFailure('live-fs-topic');
      mod.recordBroadcastFailure('test-topic');
      await mod.__flushForTests();
    },
  },
  {
    name: 'sse/insert-suppressed-two-topics',
    async run(mod) {
      mod.recordInsertSuppressed('live-fs-topic');
      mod.recordInsertSuppressed('live-fs-topic');
      mod.recordInsertSuppressed('test-topic');
      await mod.__flushForTests();
    },
  },
  {
    name: 'sse/update-suppressed-two-topics',
    async run(mod) {
      mod.recordUpdateSuppressed('live-fs-topic');
      mod.recordUpdateSuppressed('other-topic');
      mod.recordUpdateSuppressed('other-topic');
      mod.recordUpdateSuppressed('other-topic');
      await mod.__flushForTests();
    },
  },
  {
    name: 'sse/all-four-counters-plus-gauge',
    async run(mod) {
      mod.startSseMetrics(
        () =>
          new Map([
            ['live-fs-topic', 7],
            ['test-topic', 2],
          ])
      );
      mod.recordBroadcast('live-fs-topic');
      mod.recordBroadcast('test-topic');
      mod.recordBroadcastFailure('live-fs-topic');
      mod.recordInsertSuppressed('live-fs-topic');
      mod.recordInsertSuppressed('test-topic');
      mod.recordUpdateSuppressed('live-fs-topic');
      await mod.__flushForTests();
      mod.stopSseMetrics();
    },
  },
  {
    name: 'sse/gauge-only-empty-snapshot-emits-zero-companion',
    async run(mod) {
      mod.startSseMetrics(() => new Map());
      await mod.__flushForTests();
      mod.stopSseMetrics();
    },
  },
  {
    name: 'sse/gauge-only-populated-snapshot',
    async run(mod) {
      mod.startSseMetrics(() => new Map([['live-fs-topic', 3]]));
      await mod.__flushForTests();
      mod.stopSseMetrics();
    },
  },
  {
    name: 'sse/counters-only-no-gauge-registered',
    async run(mod) {
      mod.recordBroadcast('live-fs-topic');
      mod.recordBroadcastFailure('live-fs-topic');
      await mod.__flushForTests();
    },
  },
  {
    name: 'sse/size-threshold-auto-flush-at-100',
    async run(mod) {
      for (let i = 0; i < 100; i += 1) mod.recordBroadcast('live-fs-topic');
      await yieldToFlush();
    },
  },
  {
    name: 'sse/empty-flush-publishes-nothing',
    async run(mod) {
      await mod.__flushForTests();
    },
  },
];
