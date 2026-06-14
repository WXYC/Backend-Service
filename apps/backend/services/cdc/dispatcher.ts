/**
 * CDC dispatcher: owns the per-process LISTEN connection.
 *
 * Split out from `cdc-websocket.ts` (BS#1187): the LISTEN startup must run
 * independently of the WebSocket exposure so that in-process CDC subscribers
 * (`setupMetadataBroadcast()`, future consumers) keep working in environments
 * that don't configure `CDC_SECRET`. The websocket fan-out is one consumer of
 * the dispatcher, not its owner.
 *
 * Wire format and `onCdcEvent` API are unchanged — both still come from
 * `@wxyc/database` and remain the cross-consumer contract.
 *
 * BS#1120 fallback-channel sinks: `cdc_oversized` and `cdc_error` notifications
 * (emitted by migration 0094 when the primary `cdc` payload would have been
 * dropped) are wired here to `Sentry.captureMessage` so AC #3's "emit a metric
 * Sentry can alert on" is satisfied. Subscribing only — the cdc-listener owns
 * the LISTEN; this module owns the Sentry signal.
 */

import * as Sentry from '@sentry/node';
import { onCdcErrorEvent, onCdcOversizedEvent, startCdcListener, stopCdcListener } from '@wxyc/database';

/**
 * Stable Sentry fingerprints for the BS#1120 fallback channels. Each channel
 * gets a single issue group so alert thresholds count notifications, not
 * per-table churn. (The `table` is on `tags` for breakdown queries.)
 */
const OVERSIZED_FINGERPRINT = ['cdc-oversized-payload'];
const ERROR_FINGERPRINT = ['cdc-trigger-exception'];

let fallbackSinksRegistered = false;

/**
 * Wires the BS#1120 fallback channels to Sentry. Idempotent: a second call is
 * a no-op so a stray `startCdcDispatcher()` (e.g. dev hot-reload) doesn't
 * stack duplicate captures. Exported so tests can drive the wiring without
 * coupling to module-init order. `__resetCdcFallbackSinksForTests` lets the
 * test harness drop the latch between cases.
 */
export function registerCdcFallbackSinks(): void {
  if (fallbackSinksRegistered) return;
  fallbackSinksRegistered = true;

  onCdcOversizedEvent((event) => {
    Sentry.captureMessage('cdc.oversized_payload', {
      level: 'warning',
      tags: {
        subsystem: 'cdc',
        table: event.table,
        action: event.action,
        reason: event.reason,
      },
      extra: {
        schema: event.schema,
        primary_key: event.primary_key,
        payload_bytes: event.payload_bytes,
        timestamp: event.timestamp,
      },
      fingerprint: OVERSIZED_FINGERPRINT,
    });
  });

  onCdcErrorEvent((event) => {
    Sentry.captureMessage('cdc.trigger_exception', {
      level: 'error',
      tags: {
        subsystem: 'cdc',
        table: event.table,
        action: event.action,
        reason: event.reason,
        sqlstate: event.sqlstate,
      },
      extra: {
        schema: event.schema,
        sqlerrm: event.sqlerrm,
        timestamp: event.timestamp,
      },
      fingerprint: ERROR_FINGERPRINT,
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
