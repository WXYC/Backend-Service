/**
 * HTTP liveness probe for the enrichment worker (BS#892 / PR-3).
 *
 * Listens on port 8080 inside the container (the deploy-service action
 * publishes `apps/enrichment-worker/package.json#publishPort` → 8080). The
 * deploy's `--health-cmd="wget -qO- http://localhost:8080/healthcheck"`
 * polls every 30s; an unhealthy container is restarted via
 * `--restart unless-stopped`.
 *
 * Scope: full liveness (BS#1014).
 *   - 200 OK + body `ok` while the CDC LISTEN connection is alive.
 *   - 503 + body `cdc not connected` during startup (before
 *     `startCdcListener()` resolves), during shutdown (after SIGTERM/SIGINT
 *     begins draining), and after the liveness probe in `@wxyc/database`'s
 *     `cdc-listener` observes a wedged LISTEN socket (silent PG restart,
 *     NAT idle timeout, idle-transport death).
 *
 * The mid-run failure path is driven by `onCdcConnectionStateChange` in
 * `@wxyc/database`, which the worker subscribes to in `worker.ts`. When the
 * periodic `cdc_health` NOTIFY/echo loop fails to round-trip within its
 * echo-timeout window, the registered callback flips `cdcConnected=false`
 * and this endpoint starts returning 503; the deploy framework's 30s
 * `--health-cmd` poll then triggers `--restart unless-stopped`.
 *
 * The C6 stranded-claim sweep (#895) is still the backstop for rows missed
 * during the disconnect-to-restart window (~probe-cycle + echo-timeout +
 * health-poll). Liveness reduces that window from process lifetime to ~65s
 * with the default probe sizing.
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
