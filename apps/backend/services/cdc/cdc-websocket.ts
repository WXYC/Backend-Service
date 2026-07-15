/**
 * CDC WebSocket server for Backend-Service.
 *
 * Attaches to the existing Express HTTP server via the 'upgrade' event,
 * filtered to the /cdc path. Authenticates connections against CDC_SECRET via
 * an `Authorization: Bearer` header, compared in constant time (BS#1136); a
 * deprecated `?key=` query-parameter path is kept for one deploy. Fans out
 * PostgreSQL CDC events (received via the shared dispatcher's `onCdcEvent`) to
 * all connected WebSocket clients.
 *
 * The LISTEN startup itself lives in `dispatcher.ts` (BS#1187): the
 * dispatcher always runs so in-process subscribers like
 * `setupMetadataBroadcast()` work whether or not `CDC_SECRET` is configured.
 * This module owns only the external WebSocket exposure and remains
 * hard-gated on `CDC_SECRET`.
 *
 * Back-pressure & liveness (BS#1134). The previous implementation called
 * `client.send(msg, errCb)` for every CDC event with no `bufferedAmount`
 * check — a slow consumer (paused tab, suspended mobile network, paused
 * iOS test harness) accumulated outbound bytes in the `ws` library buffer
 * and Node's socket buffer with no upper bound. The 30s app-level
 * heartbeat only terminated on a send-callback error; a quietly-buffering
 * dead-but-not-closed TCP connection never tripped it. Two guards now
 * cap that growth:
 *
 *   1. `BACKPRESSURE_THRESHOLD_BYTES` (1 MiB): before every send (fan-out
 *      and heartbeat) we check `client.bufferedAmount`. Over the threshold,
 *      we `terminate()` and surface a Sentry warning
 *      (`cdc_ws.buffered_amount_high`). The CDC stream offers no replay,
 *      so dropping a single event for a slow consumer is no worse than
 *      what already happens when they reconnect — see `docs/cdc.md` for
 *      the "consumers reconcile out-of-band" contract.
 *
 *   2. Native WebSocket ping/pong on the heartbeat timer. Each tick pings
 *      every client; clients reset `isAlive=true` on `'pong'`. A client
 *      that hasn't ponged since the previous tick is terminated with a
 *      Sentry warning (`cdc_ws.missed_pong`). This decouples "client is
 *      gone" from "client is slow" — pre-#1134 a single signal mixed both.
 */

import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/node';
import { onCdcEvent } from '@wxyc/database';
import type { CdcEvent } from '@wxyc/database';

const HEARTBEAT_INTERVAL_MS = 30_000;
const CDC_PATH = '/cdc';

/**
 * Constant-time string comparison (BS#1136). The previous auth used
 * `key !== secret`, a short-circuiting per-character compare that leaks the
 * secret one byte at a time to a timing attack against the upgrade endpoint.
 *
 * `crypto.timingSafeEqual` runs in time independent of where the first
 * differing byte is, but throws if the two buffers differ in length. We
 * length-guard first and report a plain non-match — a length mismatch is
 * already a non-match, and revealing only the length (not the contents) is
 * the standard, accepted trade-off for a fixed-length shared secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Extracts the caller-supplied CDC secret from an upgrade request (BS#1136).
 *
 * Preferred: `Authorization: Bearer <secret>`. Headers are not written to
 * access logs or Sentry's request-context capture by default, so the secret
 * does not leak to log-retention systems the way a `?key=` query parameter
 * does (query strings land in CloudFront / nginx / EC2 access logs, browser
 * history, and request snapshots even under TLS).
 *
 * Deprecated (removed after one deploy): `?key=<secret>` in the URL. Kept only
 * so an in-flight consumer can migrate to the header without a lockstep
 * deploy; every use logs a deprecation warning. The secret value itself is
 * never logged. Returns `null` when neither is present.
 */
function extractCdcSecret(request: IncomingMessage, url: URL): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader) {
    // `\s+` (not a literal single space) matches the repo's Bearer-parsing
    // convention (`authenticateBearer` in apps/backend/routes/internal.route.ts,
    // `auth.middleware.ts`) and RFC 7235's `1*SP` between scheme and token, so a
    // tab- or multi-space-separated header authenticates instead of spuriously
    // 403ing or capturing leading whitespace into the compared secret.
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (match) return match[1];
  }

  const key = url.searchParams.get('key');
  if (key) {
    console.warn(
      '[cdc-ws] DEPRECATED: CDC secret supplied via the ?key= query parameter — migrate to the Authorization: Bearer header (BS#1136). Query strings leak to access logs; this path will be removed after one deploy.'
    );
    return key;
  }

  return null;
}

/**
 * Per-client outbound-buffer ceiling, in bytes. A consumer that exceeds
 * this is terminated rather than accumulating unbounded memory. 1 MiB is
 * the issue body's recommendation — large enough to absorb routine bursts
 * (a CDC event is typically <10 KiB), small enough that even a few hundred
 * connected clients can't aggregate into runaway RSS growth.
 */
const BACKPRESSURE_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Per-client liveness flag. Set true on `'pong'` arrival, cleared at the
 * start of each heartbeat tick after we ping. A client whose flag is still
 * false on the next tick has missed a pong round-trip and is terminated.
 *
 * Held as a `WeakMap` so closing the underlying connection lets the GC
 * release the bookkeeping — we never see `'close'` for a `terminate()`d
 * synthetic client in tests, and never want stale state to outlive a real
 * client.
 */
const isAlive = new WeakMap<WebSocket, boolean>();

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sends `msg` to `client` after a `bufferedAmount` check. If the buffer is
 * already over the threshold the client is terminated, a Sentry warning is
 * surfaced, and the send is skipped. Returns whether the message was sent.
 */
function safeSend(client: WebSocket, msg: string): boolean {
  if (client.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
    Sentry.captureMessage(
      `cdc_ws.buffered_amount_high — terminating slow consumer (${client.bufferedAmount} bytes buffered)`,
      {
        level: 'warning',
        tags: { tool: 'cdc-ws', step: 'backpressure' },
        extra: {
          bufferedAmount: client.bufferedAmount,
          threshold: BACKPRESSURE_THRESHOLD_BYTES,
        },
      }
    );
    console.warn(
      `[cdc-ws] Terminating slow consumer: bufferedAmount=${client.bufferedAmount} > ${BACKPRESSURE_THRESHOLD_BYTES}`
    );
    client.terminate();
    return false;
  }
  client.send(msg, (err) => {
    if (err) client.terminate();
  });
  return true;
}

/**
 * Sets up the CDC WebSocket server on the given HTTP server.
 * Handles upgrade requests to /cdc, authenticates via the
 * `Authorization: Bearer` header (constant-time compare; deprecated `?key=`
 * shim for one deploy), and registers a fan-out handler against the shared
 * CDC dispatcher. No-ops (with the canonical `[cdc-ws]` disabled log) when
 * CDC_SECRET is unset — deploy verification matches the same log line.
 */
export async function setupCdcWebSocket(server: HttpServer): Promise<void> {
  const secret = process.env.CDC_SECRET;
  if (!secret) {
    console.log('[cdc-ws] CDC_SECRET not set, CDC WebSocket disabled');
    return;
  }

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);

    if (url.pathname !== CDC_PATH) {
      // Not a CDC request — let other upgrade handlers (if any) handle it
      return;
    }

    // Auth (BS#1136): prefer the `Authorization: Bearer` header, fall back to
    // the deprecated `?key=` query parameter for one deploy, and compare with a
    // constant-time check. Never log the presented secret.
    const provided = extractCdcSecret(request, url);
    if (!provided || !constantTimeEqual(provided, secret)) {
      console.warn('[cdc-ws] Rejected connection: invalid credentials');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    // Track liveness for native ping/pong (BS#1134). A client is "alive"
    // immediately on connect; the first heartbeat tick will ping it.
    isAlive.set(ws, true);
    ws.on('pong', () => {
      isAlive.set(ws, true);
    });

    const connected = JSON.stringify({
      type: 'connected',
      serverTime: Date.now(),
    });
    safeSend(ws, connected);
    console.log(`[cdc-ws] Client connected, total=${wss!.clients.size}`);

    ws.on('close', () => {
      isAlive.delete(ws);
      console.log(`[cdc-ws] Client disconnected, total=${wss!.clients.size}`);
    });

    ws.on('error', (err) => {
      console.error('[cdc-ws] Client error:', err.message);
    });
  });

  // Heartbeat: native WebSocket ping/pong (BS#1134). On each tick we
  // terminate any client that didn't pong since the previous tick (dead
  // socket), then ping the survivors and clear their flag for next tick.
  // Pre-#1134 this was an app-level JSON message which couldn't distinguish
  // a wedged client from a slow one.
  heartbeatTimer = setInterval(() => {
    if (!wss || wss.clients.size === 0) return;
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      if (isAlive.get(client) === false) {
        Sentry.captureMessage('cdc_ws.missed_pong — terminating unresponsive consumer', {
          level: 'warning',
          tags: { tool: 'cdc-ws', step: 'missed-pong' },
        });
        console.warn('[cdc-ws] Terminating unresponsive consumer (missed pong)');
        client.terminate();
        continue;
      }

      // Back-pressure check before issuing the ping — a wedged outbound
      // buffer means the ping won't reach the wire either.
      if (client.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
        Sentry.captureMessage(
          `cdc_ws.buffered_amount_high — terminating slow consumer (${client.bufferedAmount} bytes buffered)`,
          {
            level: 'warning',
            tags: { tool: 'cdc-ws', step: 'backpressure-heartbeat' },
            extra: {
              bufferedAmount: client.bufferedAmount,
              threshold: BACKPRESSURE_THRESHOLD_BYTES,
            },
          }
        );
        console.warn(
          `[cdc-ws] Terminating slow consumer on heartbeat: bufferedAmount=${client.bufferedAmount} > ${BACKPRESSURE_THRESHOLD_BYTES}`
        );
        client.terminate();
        continue;
      }

      isAlive.set(client, false);
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  // Per-event fan-out to connected WebSocket clients.
  //
  // The event carries the FULL row (`to_jsonb(NEW)`), unprojected — including
  // the internal flowsheet columns that BS#1513 strips from the HTTP mutation /
  // peek responses. That is deliberate: `/cdc` is CDC_SECRET-gated and
  // internal-trusted, and its consumer (the reconciliation monitor) needs the
  // complete row to diff against the source of truth. See docs/cdc.md
  // "Payload shape and exposure" before adding any untrusted consumer.
  onCdcEvent((event: CdcEvent) => {
    if (!wss || wss.clients.size === 0) return;
    const msg = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        safeSend(client, msg);
      }
    }
  });

  console.log(`[cdc-ws] CDC WebSocket ready at ${CDC_PATH}`);
}

/**
 * Shuts down the CDC WebSocket server. Safe to call unconditionally —
 * a no-op when the WebSocket was never set up (e.g. `CDC_SECRET` unset).
 * The CDC LISTEN connection is owned by the dispatcher and torn down
 * separately via `shutdownCdcDispatcher()`.
 */
export async function shutdownCdcWebSocket(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (wss) {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    wss = null;
  }

  console.log('[cdc-ws] CDC WebSocket shut down');
}
