# CDC pipeline

PostgreSQL triggers broadcast every row change on `pg_notify`, and in-process Node consumers subscribe to them. There is no external endpoint: the `/cdc` WebSocket that used to fan these events out to off-box listeners was removed together with its only consumer, the tubafrenzy reconciliation monitor (see [History](#history-the-cdc-websocket)).

## Architecture

PostgreSQL triggers (`cdc_notify()`) fire `pg_notify('cdc', payload)` on every INSERT/UPDATE/DELETE. Each process that cares opens one dedicated LISTEN connection and dispatches notifications to registered handlers. No application code is instrumented, so the stream sees every change: ETL, auth, and direct SQL included.

Two processes listen today:

| Process                  | Owner of the LISTEN                                                                                           | Consumer                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/backend`           | `startCdcDispatcher()` (`apps/backend/services/cdc/dispatcher.ts`), started unconditionally at boot (BS#1187) | `setupMetadataBroadcast()` — rebroadcasts terminal metadata updates as SSE `liveFs:update` (BS#893 / BS#628) |
| `apps/enrichment-worker` | `startCdcListener()` in `apps/enrichment-worker/worker.ts`                                                    | `cdc-subscriber.ts` — claims new `pending` flowsheet track rows for LML enrichment (BS#892)                  |

Handlers register with `onCdcEvent` from `@wxyc/database`; every handler on a process sees every event.

### Fire-and-forget: no delivery guarantee

**"Sees every change" is only true while the LISTEN connection is up.** `pg_notify` is fire-and-forget — Postgres does not durably queue notifications for absent listeners, and the in-Node LISTEN buffer is bounded. A process that drops its connection (network blip, restart, deploy) misses every event between disconnect and reconnect, and there is no replay. Every consumer therefore needs an out-of-band catch-up path against the source of truth:

- the enrichment worker is backstopped by the hourly C6 gap-recovery cron (`jobs/flowsheet-metadata-backfill`, BS#895);
- a missed `liveFs:update` costs a dj-site client one stale row until its next refetch.

Any new consumer that treats the stream as a reliable event log without such a path will silently lose events. A bulk write is also visible here: a full drain can emit on the order of a million events, so a new consumer must tolerate bursts.

## Event format

```json
{
  "table": "flowsheet",
  "schema": "wxyc_schema",
  "action": "INSERT",
  "data": { "...full row as JSON..." },
  "timestamp": 1714000000000
}
```

### Payload shape and exposure (BS#1513)

The `data` field is the **full row** — the trigger emits `to_jsonb(NEW)` (or `OLD` on DELETE), every column, unprojected. For `flowsheet` events this includes every internal column the HTTP surfaces deliberately withhold; `apps/backend/utils/flowsheet-projection.ts`'s module docstring is the canonical enumeration of that withheld set.

That is safe only because the raw event never leaves the process. A consumer that forwards CDC data anywhere — SSE, an HTTP response, a log line shipped off-box — must project at its own boundary. `metadata-broadcast` does: it sends `liveFs:update` through the same allow-list the mutation echoes and DJ peek use. Do not add an external fan-out of the raw event.

## Fallback channels (BS#1120)

When the primary `cdc` payload would be dropped, migration 0096 emits on two fallback channels instead: `cdc_oversized` (payload over `pg_notify`'s size limit) and `cdc_error` (the trigger itself threw). The backend dispatcher wires both to `Sentry.captureMessage` under stable fingerprints (`cdc-oversized-payload`, `cdc-trigger-exception`), so an alert counts notifications, not per-table churn.

## Key files

- `shared/database/src/migrations/0046_cdc_notify_triggers.sql` — trigger function + per-table triggers
- `shared/database/src/migrations/0096_cdc_oversized_fallback.sql` — the BS#1120 fallback channels
- `shared/database/src/cdc-listener.ts` — dedicated LISTEN connection and `onCdcEvent` dispatch
- `apps/backend/services/cdc/dispatcher.ts` — backend LISTEN startup/shutdown + fallback-channel Sentry sinks
- `apps/backend/services/metadata-broadcast/metadata-broadcast.ts` — the backend's in-process consumer
- `apps/enrichment-worker/cdc-subscriber.ts` — the enrichment worker's consumer

## History: the `/cdc` WebSocket

Until WXYC/wiki#92, `apps/backend/services/cdc/cdc-websocket.ts` exposed the raw stream at `ws://host:8080/cdc`, gated on a shared `CDC_SECRET`. Its only consumer was `scripts/sync/reconcile.ts`, a bidirectional monitor that cross-checked tubafrenzy's MySQL against Backend's Postgres during the decommission. Once tubafrenzy went dark (2026-09-16) the monitor was deleted, and the WebSocket followed: it streamed full, unprojected rows to whoever held the secret, and that holder could not be surveyed. Both are recoverable from git history. Its auth hardening (BS#1136), back-pressure and ping/pong liveness (BS#1134), and app-level heartbeat frame (BS#2427) are documented in this file's history, not here.

The `CDC_SECRET` variable is no longer read by anything; if it is still set in an environment's `.env`, it can be deleted.
