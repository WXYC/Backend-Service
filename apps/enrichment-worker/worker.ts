/**
 * Enrichment worker entrypoint (BS#892 / Epic C C2).
 *
 * Long-running daemon that subscribes to BS's CDC stream and (eventually)
 * enriches every new flowsheet track row by calling LML. PR-1 ships in
 * log-only mode: dispatch + filter + console.log, no DB writes, no LML
 * calls. The intent is to verify in prod that the N×N CDC fan-out
 * works as designed (every worker instance receives every event)
 * before wiring the actual claim + LML + finalize sequence in PR-2.
 *
 * Deployment shape (Option A from #892 body): runs as its own Docker
 * container alongside `backend` on the same EC2. Independent restart
 * cycle; doesn't compete with HTTP traffic for the event loop.
 *
 * @see docs/cdc.md
 */

import { closeDatabaseConnection, onCdcEvent, startCdcListener, stopCdcListener } from '@wxyc/database';
import { makeLogOnlyHandler } from './cdc-subscriber.js';

const main = async (): Promise<void> => {
  console.log('[enrichment-worker] starting (PR-1: log-only mode, no DB writes)');

  onCdcEvent(makeLogOnlyHandler());
  await startCdcListener();

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
    console.log(`[enrichment-worker] received ${signal}; shutting down`);
    try {
      await stopCdcListener();
      await closeDatabaseConnection();
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
