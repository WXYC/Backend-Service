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
 */

import { startCdcListener, stopCdcListener } from '@wxyc/database';

/**
 * Starts the per-process CDC LISTEN connection. Idempotent at the listener
 * layer (`startCdcListener` warns and returns on a second call). Call once
 * at startup, before any consumer that registers via `onCdcEvent`.
 */
export async function startCdcDispatcher(): Promise<void> {
  await startCdcListener();
}

/**
 * Stops the per-process CDC LISTEN connection and clears registered
 * callbacks. Safe to call unconditionally during shutdown.
 */
export async function shutdownCdcDispatcher(): Promise<void> {
  await stopCdcListener();
}
