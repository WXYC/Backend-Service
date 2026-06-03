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
import { envInt } from '@wxyc/lml-client';
import { makeEnrichmentHandler } from './handler.js';
import { startHealthcheckServer, type HealthState } from './healthcheck.js';
import { sweepStrandedClaims } from './sweep.js';

/**
 * Stranded-claim sweep cadence (BS#1225). The C6 contract is "recover any
 * `enriching` row past the stranded-claim TTL"; the worker runs the sweep
 * at 60s so worst-case recovery latency is ~one TTL plus one sweep
 * interval. Override via env for shorter-cycle integration runs. `envInt`
 * rejects empty-string / NaN / non-positive values and falls back so a
 * deploy-config typo can't produce a tight-loop `setInterval(fn, 0)`.
 */
const SWEEP_INTERVAL_MS = envInt('ENRICHMENT_SWEEP_INTERVAL_MS', 60_000);

/**
 * Bound the shutdown wait for an in-flight sweep so SIGTERM never hangs
 * if PG is unresponsive. After this many ms we proceed with
 * `closeDatabaseConnection` regardless; postgres-js will end its pool
 * cleanly, and any straggling sweep promise rejects with a
 * `CONNECTION_ENDED` that runSweep's catch handler tolerates.
 */
const SWEEP_SHUTDOWN_WAIT_MS = 5_000;

const main = async (): Promise<void> => {
  console.log('[enrichment-worker] starting');

  // Healthcheck starts BEFORE the CDC listener so the deploy probe can hit
  // `/healthcheck` immediately (returns 503 until cdcConnected flips true).
  // A delayed start would leave the deploy seeing no listener and timing
  // out on `--health-start-period`.
  const healthState: HealthState = { cdcConnected: false };
  const healthServer = startHealthcheckServer(healthState);

  // Shutdown latch + in-flight sweep tracker, both declared up-front so
  // the SIGTERM/SIGINT handlers can be registered BEFORE any awaited
  // startup work. A signal arriving during the initial sweep below would
  // otherwise hit Node's default SIGTERM handler (immediate exit) and
  // tear the in-flight UPDATE's connection.
  let shuttingDown = false;
  let activeSweep: Promise<void> | null = null;
  let sweepTimer: NodeJS.Timeout | undefined;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    healthState.cdcConnected = false;
    console.log(`[enrichment-worker] received ${signal}; shutting down`);
    try {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      // Await any in-flight sweep so closeDatabaseConnection doesn't tear
      // its connection mid-UPDATE. Bound the wait — PG could be hung; we'd
      // rather log a slow-shutdown warning than block the deploy forever.
      if (activeSweep !== null) {
        await Promise.race([activeSweep, new Promise<void>((resolve) => setTimeout(resolve, SWEEP_SHUTDOWN_WAIT_MS))]);
      }
      await stopCdcListener();
      await closeDatabaseConnection();
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      // Flush pending Sentry spans/events so the last sweep tick's
      // `sweep.stranded_recovered_count` (and any captured exceptions
      // from runSweep) actually land. Mirrors the pattern in every
      // `jobs/*/logger.ts` shutdown path.
      await Sentry.close(2000);
    } finally {
      process.exit(0);
    }
  };

  // Register signal handlers FIRST so they cover the initial sweep below.
  // `clearInterval(undefined)` is a Node-tolerated no-op, and `activeSweep`
  // / `sweepTimer` are guarded with explicit null/undefined checks.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

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

  // BS#1225: stranded-claim recovery. Fire one tick immediately so any
  // rows left in `enriching` by a previous instance's death are recovered
  // before they sit through a full SWEEP_INTERVAL_MS, then re-run every
  // interval. Lives in-process (not as a sibling cron container) because:
  //   - The worker owns the claim lifecycle; coupling the recovery to the
  //     worker's process keeps the failure model coherent.
  //   - At a 60s cadence the container-startup cost of a separate cron job
  //     dwarfs the actual UPDATE.
  //   - Reuses the worker's existing PG connection pool.
  // The "worker is permanently dead with strands to clear" failure mode is
  // already covered by the `cdcConnected=false` healthcheck — and no new
  // strands are produced in that state anyway.
  await scheduleSweep();
  sweepTimer = setInterval(() => {
    void scheduleSweep();
  }, SWEEP_INTERVAL_MS);

  /**
   * Schedule a sweep tick with overlap and shutdown guards. The
   * `activeSweep` latch causes a tick to skip cleanly if the previous one
   * is still running (slow DB, large backlog) — without this, every tick
   * during a slow sweep would spawn another concurrent UPDATE,
   * compounding load on the partial index. The shutdown latch ensures a
   * timer callback that fires after `clearInterval` has been queued but
   * before libuv cancels it can't write to a pool that's about to close.
   */
  async function scheduleSweep(): Promise<void> {
    if (shuttingDown) return;
    if (activeSweep !== null) return;
    activeSweep = runSweep().finally(() => {
      activeSweep = null;
    });
    await activeSweep;
  }
};

/**
 * Wrap one sweep tick. The sweep itself opens a Sentry span and projects
 * the recovered count onto a child span (see `sweep.ts`); this wrapper
 * exists to catch DB errors so an unhealthy sweep can't unhandled-reject
 * and tear down the worker via setInterval's fire-and-forget callback.
 */
async function runSweep(): Promise<void> {
  try {
    const recovered = await sweepStrandedClaims();
    if (recovered > 0) {
      console.log(`[enrichment-worker] sweep recovered ${recovered} stranded claim(s)`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Sentry.captureException(err, {
      tags: { component: 'enrichment-worker', step: 'stranded_claim_sweep' },
    });
    console.error('[enrichment-worker] sweep failed', { error: message });
  }
}

void main().catch((err) => {
  console.error('[enrichment-worker] fatal startup error:', err);
  process.exit(1);
});
