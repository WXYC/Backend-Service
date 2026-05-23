/**
 * Unit tests for enrichment-worker healthcheck.ts (BS#892 / PR-3, BS#1014).
 *
 * The health server is what `--health-cmd="wget .../healthcheck"` polls
 * every 30s in the deploy. The contract is narrow but load-bearing:
 *   - 200 when the worker has a live CDC connection (cdcConnected=true)
 *   - 503 when starting up, shutting down, or after the liveness probe in
 *     `@wxyc/database`'s `cdc-listener` flips `cdcConnected=false` on a
 *     silent disconnect (cdcConnected=false)
 *   - 404 for any other path
 *   - URL with a query string still matches (cache-buster from
 *     canary/operator probes)
 *
 * The mid-run disconnect path is driven from `worker.ts` via
 * `onCdcConnectionStateChange` (the liveness machinery itself is tested in
 * `tests/unit/shared/database/cdc-listener.test.ts`). This file pins the
 * fact that the server faithfully observes mid-run flips in either direction.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { startHealthcheckServer, type HealthState } from '../../../../apps/enrichment-worker/healthcheck';

async function getStatus(port: number, path = '/healthcheck'): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

describe('healthcheck server (BS#892 PR-3)', () => {
  let server: Server | null = null;
  let port = 0;
  let state: HealthState;

  beforeEach(async () => {
    state = { cdcConnected: false };
    // port=0 → kernel-assigned free port. Avoids conflicts with sibling
    // tests + the real worker on 8080.
    const s = startHealthcheckServer(state, 0);
    server = s;
    await new Promise<void>((resolve) => s.once('listening', () => resolve()));
    const addr = s.address() as AddressInfo;
    port = addr.port;
  });

  afterEach(async () => {
    const s = server;
    if (s) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      server = null;
    }
  });

  it('returns 503 cdc not connected when cdcConnected is false', async () => {
    state.cdcConnected = false;
    const { status, body } = await getStatus(port);
    expect(status).toBe(503);
    expect(body).toBe('cdc not connected');
  });

  it('returns 200 ok when cdcConnected is true', async () => {
    state.cdcConnected = true;
    const { status, body } = await getStatus(port);
    expect(status).toBe(200);
    expect(body).toBe('ok');
  });

  it('observes mid-run cdcConnected flips (200 → 503 if the flag is toggled)', async () => {
    state.cdcConnected = true;
    expect((await getStatus(port)).status).toBe(200);
    state.cdcConnected = false;
    expect((await getStatus(port)).status).toBe(503);
  });

  it('BS#1014: a liveness-driven flip via state callback flows through to /healthcheck', async () => {
    // Simulates the wiring in worker.ts: onCdcConnectionStateChange
    // mutates state.cdcConnected, the server reads it on the next poll.
    // The cdc-listener test pins WHEN the flip happens; this test pins
    // that the server respects it.
    const stateCallback = (connected: boolean): void => {
      state.cdcConnected = connected;
    };

    stateCallback(true);
    expect((await getStatus(port)).status).toBe(200);

    // Liveness probe observes a wedged LISTEN
    stateCallback(false);
    const after = await getStatus(port);
    expect(after.status).toBe(503);
    expect(after.body).toBe('cdc not connected');

    // Postgres-js auto-reconnect → onlisten → connected=true
    stateCallback(true);
    expect((await getStatus(port)).status).toBe(200);
  });

  it('returns 404 for unknown paths', async () => {
    state.cdcConnected = true;
    const { status, body } = await getStatus(port, '/');
    expect(status).toBe(404);
    expect(body).toBe('not found');
  });

  it('matches /healthcheck even with a query string (canary cache-buster)', async () => {
    state.cdcConnected = true;
    expect((await getStatus(port, '/healthcheck?ts=12345')).status).toBe(200);
  });

  it('matches trailing-slash variant /healthcheck/', async () => {
    state.cdcConnected = true;
    expect((await getStatus(port, '/healthcheck/')).status).toBe(200);
  });
});
