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

import { closeDatabaseConnection, onCdcEvent, startCdcListener, stopCdcListener } from '@wxyc/database';
import { makeEnrichmentHandler } from './handler.js';
import { startHealthcheckServer, type HealthState } from './healthcheck.js';

const main = async (): Promise<void> => {
  console.log('[enrichment-worker] starting');

  // Healthcheck starts BEFORE the CDC listener so the deploy probe can hit
  // `/healthcheck` immediately (returns 503 until cdcConnected flips true).
  // A delayed start would leave the deploy seeing no listener and timing
  // out on `--health-start-period`.
  const healthState: HealthState = { cdcConnected: false };
  const healthServer = startHealthcheckServer(healthState);

  onCdcEvent(makeEnrichmentHandler());
  await startCdcListener();
  healthState.cdcConnected = true;

  console.log('[enrichment-worker] subscribed to CDC; awaiting events');

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

void main().catch((err) => {
  console.error('[enrichment-worker] fatal startup error:', err);
  process.exit(1);
});
