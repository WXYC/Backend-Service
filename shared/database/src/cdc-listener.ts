/**
 * CDC (Change Data Capture) listener for PostgreSQL LISTEN/NOTIFY.
 *
 * Creates a dedicated postgres-js connection for LISTEN (the query connection
 * cannot be reused for subscriptions). Parses CDC notification payloads and
 * dispatches them to registered callbacks.
 *
 * Liveness (BS#1014): a sibling LISTEN on `cdc_health` plus a periodic
 * self-NOTIFY echo turns a silently-dead LISTEN connection into a 503 on the
 * worker's /healthcheck within ~one probe-cycle + echo-timeout. Postgres-js's
 * `onlisten` callback (third arg of `listen()`) also dispatches connected=true
 * on the initial subscribe and on every auto-reconnect.
 */

import postgres from 'postgres';

export interface CdcEvent {
  table: string;
  schema: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  data: Record<string, unknown> | null;
  timestamp: number;
}

export type CdcEventCallback = (event: CdcEvent) => void;
export type CdcConnectionStateCallback = (connected: boolean) => void;

const CDC_CHANNEL = 'cdc';
const HEALTH_CHANNEL = 'cdc_health';

let listenConnection: ReturnType<typeof postgres> | null = null;
let callbacks: CdcEventCallback[] = [];
let stateCallbacks: CdcConnectionStateCallback[] = [];

let livenessTimer: ReturnType<typeof setInterval> | null = null;
let outstandingProbeToken: string | null = null;
let outstandingProbeAt = 0;
let lastDispatchedState: boolean | null = null;

/**
 * Registers a callback to receive CDC events.
 * Multiple callbacks can be registered; all are invoked for each event.
 */
export function onCdcEvent(callback: CdcEventCallback): void {
  callbacks.push(callback);
}

/**
 * Registers a callback fired on CDC connection-state transitions.
 *
 * - `true` on initial successful subscribe and on every postgres-js auto-reconnect
 *   (re-LISTEN), and on every received liveness echo while the probe is enabled.
 * - `false` only when the liveness probe is enabled AND the in-flight probe has
 *   exceeded `echoTimeoutMs` without an echo (or the NOTIFY itself failed).
 *   Without `enableLivenessProbe()`, the listener has no way to detect a
 *   silently-dead LISTEN socket and will never dispatch `false` from this path;
 *   callers that want silent-drop detection must call `enableLivenessProbe()`.
 *
 * Duplicate transitions are suppressed: the same state is not re-dispatched
 * back-to-back (so a healthy probe doesn't churn callbacks every interval).
 */
export function onCdcConnectionStateChange(callback: CdcConnectionStateCallback): void {
  stateCallbacks.push(callback);
}

function dispatchState(connected: boolean): void {
  if (lastDispatchedState === connected) return;
  lastDispatchedState = connected;
  for (const cb of stateCallbacks) {
    try {
      cb(connected);
    } catch (err) {
      console.error('[cdc-listener] State callback error:', err);
    }
  }
}

/**
 * Starts the CDC listener. Creates a dedicated LISTEN connection and
 * subscribes to the 'cdc' channel. The `onlisten` hook dispatches
 * `connected=true` to any callbacks registered via
 * `onCdcConnectionStateChange`, including on every postgres-js auto-reconnect.
 */
export async function startCdcListener(): Promise<void> {
  if (listenConnection) {
    console.warn('[cdc-listener] Already started');
    return;
  }

  listenConnection = postgres({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT != null ? Number(process.env.DB_PORT) : 5432,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });

  await listenConnection.listen(
    CDC_CHANNEL,
    (payload: string) => {
      try {
        const event = JSON.parse(payload) as CdcEvent;
        for (const cb of callbacks) {
          try {
            cb(event);
          } catch (err) {
            console.error('[cdc-listener] Callback error:', err);
          }
        }
      } catch (err) {
        console.error('[cdc-listener] Failed to parse CDC payload:', err);
      }
    },
    () => {
      // Fires on initial subscribe AND on every postgres-js auto-reconnect's
      // re-LISTEN. Either way the LISTEN is live again, so flip back to true.
      dispatchState(true);
    }
  );

  console.log('[cdc-listener] Listening on channel:', CDC_CHANNEL);
}

export interface LivenessProbeOptions {
  /** How often to attempt a probe. Default: 10s. */
  probeIntervalMs?: number;
  /** How long a probe may remain un-echoed before dispatching connected=false. Default: 25s. */
  echoTimeoutMs?: number;
}

/**
 * Enables periodic self-NOTIFY probes on the `cdc_health` channel.
 *
 * Why: postgres-js's `onlisten` hook fires on (re)subscribe but does not fire
 * on a silent socket death. Without a probe, the LISTEN connection can wedge
 * (PG restart with no RST, NAT idle timeout, idle-transport death) while the
 * process keeps reporting healthy. The probe sends a NOTIFY through any pool
 * connection; if the LISTEN connection is alive, the echo arrives. If not,
 * the next interval tick observes the un-echoed probe and dispatches
 * `connected=false`, which the worker's healthcheck consumes to return 503.
 *
 * Sizing rationale: with the defaults (10s interval, 25s echo timeout) the
 * worst-case detection latency is one probe interval + one echo timeout =
 * 35s, then up to one health-poll cycle (30s) before the deploy framework
 * acts → ~65s total. Within the C6 stranded-claim sweep's coverage window.
 *
 * Must be called after `startCdcListener()`.
 */
export async function enableLivenessProbe(opts: LivenessProbeOptions = {}): Promise<void> {
  if (!listenConnection) {
    throw new Error('[cdc-listener] enableLivenessProbe called before startCdcListener');
  }
  if (livenessTimer) {
    console.warn('[cdc-listener] Liveness probe already enabled');
    return;
  }

  const probeIntervalMs = opts.probeIntervalMs ?? 10_000;
  const echoTimeoutMs = opts.echoTimeoutMs ?? 25_000;

  await listenConnection.listen(HEALTH_CHANNEL, (payload: string) => {
    if (payload === outstandingProbeToken) {
      outstandingProbeToken = null;
      outstandingProbeAt = 0;
      dispatchState(true);
    }
    // Other workers' probe tokens echo here too (multi-instance deploy).
    // Ignore them — each instance only cares about its own echo.
  });

  livenessTimer = setInterval(() => {
    void runProbeTick(echoTimeoutMs);
  }, probeIntervalMs);

  console.log(`[cdc-listener] Liveness probe enabled (interval=${probeIntervalMs}ms, echo-timeout=${echoTimeoutMs}ms)`);
}

async function runProbeTick(echoTimeoutMs: number): Promise<void> {
  if (!listenConnection) return;

  // If a probe is already outstanding, evaluate whether it's exceeded the
  // echo timeout. Don't issue a new one — we want a clean failure signal,
  // not overlapping probes that might mask a wedge.
  if (outstandingProbeToken !== null) {
    if (Date.now() - outstandingProbeAt >= echoTimeoutMs) {
      dispatchState(false);
    }
    return;
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  outstandingProbeToken = token;
  outstandingProbeAt = Date.now();

  try {
    await listenConnection.notify(HEALTH_CHANNEL, token);
  } catch (err) {
    console.error('[cdc-listener] Liveness probe NOTIFY failed:', err);
    // NOTIFY itself failing means the pool can't talk to PG at all. Don't
    // wait the echo timeout — surface immediately.
    outstandingProbeToken = null;
    outstandingProbeAt = 0;
    dispatchState(false);
  }
}

/**
 * Stops the CDC listener and closes the dedicated connection.
 */
export async function stopCdcListener(): Promise<void> {
  if (livenessTimer) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }
  outstandingProbeToken = null;
  outstandingProbeAt = 0;
  lastDispatchedState = null;

  if (listenConnection) {
    await listenConnection.end();
    listenConnection = null;
    callbacks = [];
    stateCallbacks = [];
    console.log('[cdc-listener] Stopped');
  }
}
