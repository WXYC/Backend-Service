/**
 * CDC WebSocket server for Backend-Service.
 *
 * Attaches to the existing Express HTTP server via the 'upgrade' event,
 * filtered to the /cdc path. Authenticates connections via CDC_SECRET
 * query parameter. Broadcasts PostgreSQL CDC events (from LISTEN/NOTIFY)
 * to all connected clients.
 */

import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { onCdcEvent, startCdcListener, stopCdcListener } from '@wxyc/database';
import type { CdcEvent } from '@wxyc/database';

const HEARTBEAT_INTERVAL_MS = 30_000;
const CDC_PATH = '/cdc';

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sets up the CDC WebSocket server on the given HTTP server.
 * Handles upgrade requests to /cdc, authenticates via query parameter,
 * and starts the PostgreSQL CDC listener.
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

    const key = url.searchParams.get('key');
    if (!key || key !== secret) {
      console.warn('[cdc-ws] Rejected connection: invalid key');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const connected = JSON.stringify({
      type: 'connected',
      serverTime: Date.now(),
    });
    ws.send(connected);
    console.log(`[cdc-ws] Client connected, total=${wss!.clients.size}`);

    ws.on('close', () => {
      console.log(`[cdc-ws] Client disconnected, total=${wss!.clients.size}`);
    });

    ws.on('error', (err) => {
      console.error('[cdc-ws] Client error:', err.message);
    });
  });

  // Start heartbeat
  heartbeatTimer = setInterval(() => {
    if (!wss || wss.clients.size === 0) return;
    const msg = JSON.stringify({ type: 'heartbeat', timestamp: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg, (err) => {
          if (err) client.terminate();
        });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  // Register CDC event handler
  onCdcEvent((event: CdcEvent) => {
    if (!wss || wss.clients.size === 0) return;
    const msg = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg, (err) => {
          if (err) client.terminate();
        });
      }
    }
  });

  // Start listening for PostgreSQL notifications
  await startCdcListener();
  console.log(`[cdc-ws] CDC WebSocket ready at ${CDC_PATH}`);
}

/**
 * Shuts down the CDC WebSocket server and stops the PostgreSQL listener.
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

  await stopCdcListener();
  console.log('[cdc-ws] CDC WebSocket shut down');
}
