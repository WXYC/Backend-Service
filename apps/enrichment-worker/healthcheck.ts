/**
 * Minimal HTTP healthcheck server for the enrichment worker (BS#892 / PR-3).
 *
 * Listens on port 8080 inside the container (the deploy-service action
 * publishes `apps/enrichment-worker/package.json#publishPort` → 8080). The
 * deploy's `--health-cmd="wget -qO- http://localhost:8080/healthcheck"`
 * polls every 30s; an unhealthy container is restarted via
 * `--restart unless-stopped`.
 *
 * Endpoint: `GET /healthcheck`
 *   - 200 OK + body `ok` when the CDC listener is connected.
 *   - 503 + body `cdc not connected` when the worker is starting up or has
 *     lost its LISTEN connection. (Loss-of-connection without a clean
 *     reconnect would otherwise be silent — the worker process stays alive
 *     but no events arrive.)
 *
 * The HTTP server is independently necessary: the deploy framework treats
 * apps/ packages as HTTP services. Without an HTTP healthcheck the container
 * is marked unhealthy on first poll and restart-thrashes. Adding a server
 * here also gives canaries (WXYC/wxyc-canary) and operators a probe point.
 *
 * The server is intentionally `node:http`, not Express — the worker has no
 * other route surface and Express would pull a 50KB+ dep into the container
 * for a single 4-line handler.
 */

import { createServer, type Server } from 'node:http';

export type HealthState = {
  cdcConnected: boolean;
};

export function startHealthcheckServer(state: HealthState, port = 8080): Server {
  const server = createServer((req, res) => {
    if (req.url === '/healthcheck' || req.url === '/healthcheck/') {
      if (state.cdcConnected) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      } else {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('cdc not connected');
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, () => {
    console.log(`[enrichment-worker] healthcheck listening on :${port}/healthcheck`);
  });

  return server;
}
