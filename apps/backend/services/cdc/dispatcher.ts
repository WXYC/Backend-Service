/**
 * CDC dispatcher: owns the per-process LISTEN connection.
 *
 * Split out from the former `cdc-websocket.ts` (BS#1187) so the LISTEN
 * startup ran independently of the `CDC_SECRET`-gated WebSocket exposure.
 * That WebSocket was removed with its only consumer (WXYC/wiki#92); the
 * dispatcher now serves only in-process subscribers
 * (`setupMetadataBroadcast()`, future consumers).
 *
 * Wire format and `onCdcEvent` API are unchanged — both still come from
 * `@wxyc/database` and remain the cross-consumer contract.
 *
 * BS#1120 fallback-channel sinks: `cdc_oversized` and `cdc_error` notifications
 * (emitted by migration 0094 when the primary `cdc` payload would have been
 * dropped) are wired here to `logCounter` (BS#3402), one structured log line each.
 * Subscribing only — the cdc-listener owns the LISTEN; this module owns the
 * signal.
 */

import { logCounter } from '@wxyc/observability';
import { onCdcErrorEvent, onCdcOversizedEvent, startCdcListener, stopCdcListener } from '@wxyc/database';

let fallbackSinksRegistered = false;

/**
 * Wires the BS#1120 fallback channels to counters. Idempotent: a second call is
 * a no-op so a stray `startCdcDispatcher()` (e.g. dev hot-reload) doesn't
 * stack duplicate counts. Exported so tests can drive the wiring without
 * coupling to module-init order. `__resetCdcFallbackSinksForTests` lets the
 * test harness drop the latch between cases.
 */
export function registerCdcFallbackSinks(): void {
  if (fallbackSinksRegistered) return;
  fallbackSinksRegistered = true;

  onCdcOversizedEvent((event) => {
    logCounter('cdc.oversized_payload', 1, {
      subsystem: 'cdc',
      table: event.table,
      action: event.action,
      reason: event.reason,
      schema: event.schema,
      primary_key: event.primary_key ?? '',
      payload_bytes: event.payload_bytes,
    });
  });

  onCdcErrorEvent((event) => {
    logCounter('cdc.trigger_exception', 1, {
      subsystem: 'cdc',
      table: event.table,
      action: event.action,
      reason: event.reason,
      sqlstate: event.sqlstate,
      schema: event.schema,
    });
  });
}

/**
 * Starts the per-process CDC LISTEN connection. Idempotent at the listener
 * layer (`startCdcListener` warns and returns on a second call) and at the
 * fallback-sink layer (`registerCdcFallbackSinks` no-ops on the second call
 * via its module-level latch). Call once at startup, before any consumer that
 * registers via `onCdcEvent`.
 */
export async function startCdcDispatcher(): Promise<void> {
  registerCdcFallbackSinks();
  await startCdcListener();
}

/**
 * Stops the per-process CDC LISTEN connection and clears registered
 * callbacks. Safe to call unconditionally during shutdown.
 *
 * Drops the fallback-sink latch so a subsequent `startCdcDispatcher()` (test
 * harness, future hot-reload) re-wires the captures against the freshly
 * cleared `@wxyc/database` callback arrays.
 */
export async function shutdownCdcDispatcher(): Promise<void> {
  await stopCdcListener();
  fallbackSinksRegistered = false;
}
