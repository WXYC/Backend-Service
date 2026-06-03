/**
 * Enrichment worker entrypoint (BS#892 / Epic C C2).
 *
 * Long-running daemon that subscribes to BS's CDC stream and enriches every
 * new flowsheet track row by calling LML. The N×N idempotent-claim pattern
 * means every worker instance receives every event; the first to win the
 * atomic claim does the work, the losers skip cleanly.
 *
 * Deployment shape (Option A from #892 body): runs as its own Docker
 * container alongside `backend` on the same EC2. Independent restart
 * cycle; doesn't compete with HTTP traffic for the event loop.
 *
 * @see docs/cdc.md
 */

import * as Sentry from '@sentry/node';
import {
  closeDatabaseConnection,
  enableLivenessProbe,
  onCdcConnectionStateChange,
  onCdcEvent,
  startCdcListener,
  stopCdcListener,
} from '@wxyc/database';
import { makeEnrichmentHandler } from './handler.js';
import { startHealthcheckServer, type HealthState } from './healthcheck.js';
import { sweepStrandedClaims } from './sweep.js';

/**
 * Stranded-claim sweep cadence (BS#1225). The C6 contract is "recover any
 * `enriching` row past `enriching_since + 60s`"; the worker runs the sweep
 * at 60s so the worst-case recovery latency is ~120s (one full TTL plus one
 * full sweep interval). Override via env for shorter-cycle integration runs.
 */
const SWEEP_INTERVAL_MS = Number(process.env.ENRICHMENT_SWEEP_INTERVAL_MS ?? 60_000);

const main = async (): Promise<void> => {
  console.log('[enrichment-worker] starting');

  // Healthcheck starts BEFORE the CDC listener so the deploy probe can hit
  // `/healthcheck` immediately (returns 503 until cdcConnected flips true).
  // A delayed start would leave the deploy seeing no listener and timing
  // out on `--health-start-period`.
  const healthState: HealthState = { cdcConnected: false };
  const healthServer = startHealthcheckServer(healthState);

  // BS#1014: dispatched true on initial LISTEN + every postgres-js reconnect,
  // dispatched false when the liveness probe observes a wedged LISTEN socket.
  onCdcConnectionStateChange((connected) => {
    healthState.cdcConnected = connected;
    console.log(`[enrichment-worker] cdcConnected=${connected}`);
  });

  onCdcEvent(makeEnrichmentHandler());
  await startCdcListener();
  // Belt-and-suspenders: the onlisten hook should have already flipped this
  // to true; re-assert in case a future cdc-listener change skips dispatch.
  healthState.cdcConnected = true;

  // BS#1014: probe the LISTEN socket via a sibling NOTIFY/echo loop so a
  // silent disconnect (PG restart without RST, NAT idle, idle-transport
  // death) flips cdcConnected=false within ~one probe cycle.
  await enableLivenessProbe();

  console.log('[enrichment-worker] subscribed to CDC; awaiting events');

  // BS#1225: stranded-claim recovery. Fire one tick immediately so any rows
  // left in `enriching` by a previous instance's death are recovered before
  // they sit through a full SWEEP_INTERVAL_MS, then re-run every interval.
  // Lives in-process (not as a sibling cron container) because:
  //   - The worker owns the claim lifecycle; coupling the recovery to the
  //     worker's process keeps the failure model coherent.
  //   - At a 60s cadence the container-startup cost of a separate cron job
  //     dwarfs the actual UPDATE.
  //   - Reuses the worker's existing PG connection pool.
  // The "worker is permanently dead with strands to clear" failure mode is
  // already covered by the `cdcConnected=false` healthcheck — and no new
  // strands are produced in that state anyway.
  await runSweep();
  const sweepTimer = setInterval(() => {
    void runSweep();
  }, SWEEP_INTERVAL_MS);
  // setInterval keeps the event loop alive on its own; explicit so a future
  // refactor doesn't accidentally let the process exit before SIGTERM.

  // Graceful shutdown: SIGTERM (docker stop) and SIGINT (Ctrl+C). The
  // LISTEN connection holds a pg socket open, so stopping cleanly avoids
  // a "connection terminated unexpectedly" log on the database side.
  // The `shuttingDown` latch guards against concurrent SIGTERM+SIGINT
  // (or a duplicate signal) racing through `stopCdcListener` +
  // `closeDatabaseConnection`.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    healthState.cdcConnected = false;
    console.log(`[enrichment-worker] received ${signal}; shutting down`);
    try {
      clearInterval(sweepTimer);
      await stopCdcListener();
      await closeDatabaseConnection();
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

/**
 * Wrap one sweep tick. The sweep itself opens a Sentry span and projects
 * the recovered count onto it (see `sweep.ts`); this wrapper exists to
 * catch DB errors so an unhealthy sweep can't unhandled-reject and tear
 * down the worker via setInterval's fire-and-forget callback.
 */
async function runSweep(): Promise<void> {
  try {
    const recovered = await sweepStrandedClaims();
    if (recovered > 0) {
      console.log(`[enrichment-worker] sweep recovered ${recovered} stranded claim(s)`);
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'enrichment-worker', step: 'stranded_claim_sweep' },
    });
    console.error('[enrichment-worker] sweep failed', { error: (err as Error).message });
  }
}

void main().catch((err) => {
  console.error('[enrichment-worker] fatal startup error:', err);
  process.exit(1);
});
