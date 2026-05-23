/**
 * Unit tests for enrichment-worker healthcheck.ts (BS#892 / PR-3).
 *
 * The health server is what `--health-cmd="wget .../healthcheck"` polls
 * every 30s in the deploy. The contract is narrow but load-bearing:
 *   - 200 when the worker has finished startup (cdcConnected=true)
 *   - 503 when starting up or shutting down (cdcConnected=false)
 *   - 404 for any other path
 *   - URL with a query string still matches (cache-buster from
 *     canary/operator probes)
 *
 * Limitations the tests pin: this is a liveness probe scoped to startup +
 * shutdown. A silently-dead LISTEN connection is NOT detected — that's
 * BS#1014. A regression that flipped `cdcConnected` to false during normal
 * operation (e.g., from an unrelated code path) would surface as 503s
 * here; the unit test for that interaction lives wherever the flip would
 * be wired, not in this file.
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
