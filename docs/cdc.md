# CDC WebSocket Endpoint

WebSocket endpoint at `/cdc` that broadcasts all database changes via PostgreSQL LISTEN/NOTIFY triggers. Used by the reconciliation monitor for cross-database verification.

## Endpoint

`ws://host:8080/cdc?key=<CDC_SECRET>` — requires `CDC_SECRET` environment variable.

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

## Architecture

PostgreSQL triggers (`cdc_notify()`) fire `pg_notify('cdc', payload)` on every INSERT/UPDATE/DELETE. A dedicated LISTEN connection in Node.js receives notifications and broadcasts them to WebSocket clients. Zero application code instrumentation — captures all changes including ETL, auth, and direct SQL.

**Load-bearing dependency: "captures all changes" is only true while a consumer is connected.** `pg_notify` is fire-and-forget — Postgres does not durably queue notifications for absent listeners, and the in-Node LISTEN buffer is bounded. A WebSocket consumer that drops its connection (network blip, restart, backpressure) misses every event between disconnect and reconnect, and there is no replay endpoint. Consumers that need a complete change record must compare against the source of truth on reconnect — the reconciliation monitor below is the canonical example, not a generic utility. Any new consumer that treats the CDC stream as a reliable event log without an out-of-band catch-up path will silently lose events.

## Key files

- `shared/database/src/migrations/0045_cdc_notify_triggers.sql` — trigger function + per-table triggers
- `shared/database/src/cdc-listener.ts` — dedicated LISTEN connection and event dispatch
- `apps/backend/services/cdc/cdc-websocket.ts` — WebSocket server with auth and heartbeat

## Reconciliation monitor

```bash
CDC_SECRET=xxx npx tsx scripts/sync/reconcile.ts
```

Bidirectional: forward verifies tubafrenzy SSE events land in Backend-Service PG; reverse verifies PG WS events land in a local `wxycmusic` MySQL clone (defaults to `localhost:3306`). Reports matches, mismatches, missing in real time.

The reverse direction's local clone is refreshed via `scripts/sync/refresh-local-mysql.sh`, which chains tubafrenzy's `backup-database.sh` (mysqldump over SSH) with a local DROP + CREATE + import. Run it on a cron / launchd timer (e.g. every 15 min) — without periodic refresh the clone drifts and produces false `NOT FOUND` warnings for any row newer than the last snapshot. There is no event-driven sync; the snapshot cadence is the reverse-direction freshness ceiling.
