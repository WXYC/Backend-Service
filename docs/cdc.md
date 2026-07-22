# CDC WebSocket Endpoint

WebSocket endpoint at `/cdc` that broadcasts all database changes via PostgreSQL LISTEN/NOTIFY triggers. Used by the reconciliation monitor for cross-database verification.

## Endpoint

`ws://host:8080/cdc` — requires `CDC_SECRET` environment variable.

### Authentication (BS#1136)

Present the shared secret in an `Authorization: Bearer <CDC_SECRET>` header. The upgrade handler compares it against `CDC_SECRET` with `crypto.timingSafeEqual` (length-guarded, constant time). A missing or wrong secret gets a `403 Forbidden` and the socket is destroyed; the presented secret is never logged.

```ts
new WebSocket('ws://host:8080/cdc', { headers: { Authorization: `Bearer ${CDC_SECRET}` } });
```

The header path replaces the old `?key=<CDC_SECRET>` query parameter, which leaked the secret to every HTTP-aware intermediary on the path (CloudFront / nginx / EC2 access logs, browser history, request snapshots) even under TLS, and used a non-constant-time `!==` compare vulnerable to a byte-at-a-time timing attack.

**Deprecated shim, removed after one deploy:** the upgrade handler still accepts `?key=<CDC_SECRET>` for backwards compatibility, but every use logs a `[cdc-ws] DEPRECATED: … ?key= …` warning. Migrate any out-of-band consumer to the header, then delete the `?key=` branch in `apps/backend/services/cdc/cdc-websocket.ts` (`extractCdcSecret`). The in-repo consumer (`scripts/sync/reconcile.ts`) already uses the header.

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

## Payload shape and exposure (BS#1513)

The `data` field is the **full row** — the trigger emits `to_jsonb(NEW)` (or `OLD` on DELETE), every column, unprojected. For `flowsheet` events this therefore includes every internal column the HTTP surfaces deliberately withhold: BS#1513 projects the mutation / DJ-peek responses through the allow-list in `apps/backend/utils/flowsheet-projection.ts`, whose module docstring is the canonical enumeration of the withheld set and the per-column rationale. (`metadata_status` is _not_ withheld — it is client-facing per the `FlowsheetEntryResponse` SSOT and rides both the HTTP projections and this stream.)

This is intentional and stays unprojected: the `/cdc` channel is **internal-trusted**, hard-gated on `CDC_SECRET`, and its sole consumer is the reconciliation monitor, which needs the complete row to diff against the source of truth. Projecting the fan-out would defeat that purpose and require touching the trigger SQL. A new internal column added to `flowsheet` _will_ appear on this stream — that is acceptable here (unlike the HTTP responses) precisely because the audience is trusted and the payload is a verification artifact, not a client contract. If an untrusted consumer is ever added, project at that consumer's boundary rather than widening this channel's contract.

## Key files

- `shared/database/src/migrations/0045_cdc_notify_triggers.sql` — trigger function + per-table triggers
- `shared/database/src/cdc-listener.ts` — dedicated LISTEN connection and event dispatch
- `apps/backend/services/cdc/dispatcher.ts` — per-process LISTEN startup/shutdown. Runs unconditionally so in-process consumers (`metadata-broadcast`) work regardless of `CDC_SECRET` (BS#1187)
- `apps/backend/services/cdc/cdc-websocket.ts` — WebSocket server with auth and heartbeat; gated on `CDC_SECRET` (external-listener channel only)

## Back-pressure and liveness (BS#1134)

Per-client guards in `cdc-websocket.ts` keep one misbehaving consumer from leaking memory or wedging the heartbeat signal:

- **Back-pressure**: every send (fan-out and heartbeat) checks `client.bufferedAmount`. Over `BACKPRESSURE_THRESHOLD_BYTES` (1 MiB) the client is `terminate()`d and a Sentry `cdc_ws.buffered_amount_high` warning is captured. The CDC stream offers no replay, so dropping a single event for a slow consumer is no worse than what already happens at reconnect (see the "consumers reconcile out-of-band" contract above).
- **Native ping/pong**: the 30s heartbeat now uses `ws.ping()` and tracks `'pong'` arrival, not an app-level JSON message. Clients that miss a pong before the next tick are terminated with a Sentry `cdc_ws.missed_pong` warning. This decouples "client is wedged" from "client is slow" — pre-#1134 the app-level message conflated both into a single send-callback signal.

## Reconciliation monitor

```bash
CDC_SECRET=xxx npx tsx scripts/sync/reconcile.ts
```

Bidirectional: forward verifies tubafrenzy SSE events land in Backend-Service PG; reverse verifies PG WS events land in a local `wxycmusic` MySQL clone (defaults to `localhost:3306`). Reports matches, mismatches, missing in real time.

The reverse direction's local clone is refreshed via `scripts/sync/refresh-local-mysql.sh`, which chains tubafrenzy's `backup-database.sh` (mysqldump over SSH) with a local DROP + CREATE + import. Run it on a cron / launchd timer (e.g. every 15 min) — without periodic refresh the clone drifts and produces false `NOT FOUND` warnings for any row newer than the last snapshot. There is no event-driven sync; the snapshot cadence is the reverse-direction freshness ceiling.
