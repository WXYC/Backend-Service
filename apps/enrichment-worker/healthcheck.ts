/**
 * HTTP liveness probe for the enrichment worker (BS#892 / PR-3).
 *
 * Listens on port 8080 inside the container (the deploy-service action
 * publishes `apps/enrichment-worker/package.json#publishPort` → 8080). The
 * deploy's `--health-cmd="wget -qO- http://localhost:8080/healthcheck"`
 * polls every 30s; an unhealthy container is restarted via
 * `--restart unless-stopped`.
 *
 * Scope: startup + shutdown probe only.
 *   - 200 OK + body `ok` after `startCdcListener()` resolved successfully.
 *   - 503 + body `cdc not connected` during startup (before the listener
 *     resolves) and during shutdown (after SIGTERM/SIGINT begins draining).
 *
 * What this probe does NOT detect: a mid-run LISTEN drop that
 * `@wxyc/database`'s cdc-listener doesn't surface back to its callers (PG
 * restart, network blip without RST, idle-transport death). The
 * `cdcConnected` flag only flips back to `false` in the shutdown path —
 * a silently-dead LISTEN connection will continue to report healthy here.
 * Real liveness detection requires a connection-lifecycle hook in
 * `@wxyc/database` (or a periodic NOTIFY-back probe); tracked at BS#1014.
 * In the meantime, the C6 stranded-claim sweep (#895) recovers any rows
 * lost to a wedged worker — a backstop, not a substitute.
 *
 * The HTTP server is independently necessary: the deploy framework treats
 * apps/ packages as HTTP services. Without one the container is marked
 * unhealthy on first poll and restart-thrashes. Adding a server here also
 * gives canaries (WXYC/wxyc-canary) and operators a probe point.
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
    // Match pathname only — operators / canaries (WXYC/wxyc-canary) may
    // append a cache-buster query string, which would otherwise miss.
    const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '';
    if (pathname === '/healthcheck' || pathname === '/healthcheck/') {
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
