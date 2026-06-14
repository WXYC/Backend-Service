/**
 * Unit tests for the CDC dispatcher / websocket split (BS#1187) and the
 * back-pressure + native ping/pong hardening (BS#1134).
 *
 * Pre-BS#1187, `setupCdcWebSocket` owned both the WebSocket exposure AND
 * the per-process `startCdcListener()` call. A missing `CDC_SECRET` short-
 * circuited the function before the LISTEN ever started, which silently
 * disabled every in-process subscriber that registered via `onCdcEvent`
 * — most importantly `setupMetadataBroadcast()`, the dj-site
 * `liveFs:update` SSE bridge.
 *
 * Pin the new shape:
 *   1. `startCdcDispatcher()` calls `startCdcListener()` unconditionally.
 *   2. `setupCdcWebSocket()` is still secret-gated; no LISTEN side effect.
 *   3. With `CDC_SECRET` unset: dispatcher started, log emitted, no LISTEN
 *      call from the websocket path, no WebSocketServer bound.
 *   4. With `CDC_SECRET` set: dispatcher started, websocket fan-out
 *      handler registered, no second LISTEN start.
 *
 * BS#1134 additions:
 *   5. Per-client `bufferedAmount` is checked before every send (heartbeat
 *      and fan-out). When it exceeds the threshold the client is
 *      `terminate()`d, a Sentry warning is captured, and the event is not
 *      sent — this caps unbounded outbound buffer growth caused by a slow
 *      consumer.
 *   6. The heartbeat now uses native WebSocket ping/pong frames (not an
 *      app-level JSON message). Clients that don't pong before the next
 *      heartbeat tick are terminated with a Sentry warning.
 *   7. The `'pong'` arrival keeps the connection alive across the next
 *      heartbeat tick.
 *
 * The metadata-broadcast subscriber's actual filtering is covered in
 * `metadata-broadcast.test.ts`; this file pins the wiring contract that
 * lets it fire in the first place.
 */

jest.mock('@wxyc/database', () => ({
  onCdcEvent: jest.fn(),
  startCdcListener: jest.fn().mockResolvedValue(undefined),
  stopCdcListener: jest.fn().mockResolvedValue(undefined),
}));

const captureMessageMock = jest.fn();
jest.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

// Captured server-level handlers so tests can drive the `'connection'` event
// against a synthetic client. Reset in `beforeEach`.
const wssHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
const wssClients = new Set<unknown>();

jest.mock('ws', () => {
  const WebSocketServer = jest.fn().mockImplementation(() => {
    return {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        (wssHandlers[event] ||= []).push(handler);
      },
      close: jest.fn(),
      clients: wssClients,
      handleUpgrade: jest.fn(),
      emit: jest.fn(),
    };
  });
  return {
    WebSocketServer,
    WebSocket: { OPEN: 1 },
  };
});

import type { Server as HttpServer } from 'http';
import { onCdcEvent, startCdcListener, stopCdcListener } from '@wxyc/database';
import { WebSocketServer } from 'ws';
import { setupCdcWebSocket, shutdownCdcWebSocket } from '../../../../../../apps/backend/services/cdc/cdc-websocket';
import { startCdcDispatcher, shutdownCdcDispatcher } from '../../../../../../apps/backend/services/cdc/dispatcher';

const makeServer = (): HttpServer => {
  const server = { on: jest.fn(), setTimeout: jest.fn() };
  return server as unknown as HttpServer;
};

/**
 * Synthetic client modelled on the surface `cdc-websocket.ts` consumes from
 * the `ws` library: `readyState`, `bufferedAmount`, `send`, `ping`,
 * `terminate`, and event-handler registration via `on`. The connection-time
 * `'pong'` handler is captured so tests can simulate a client responding to
 * a heartbeat ping.
 */
type SyntheticClient = {
  readyState: number;
  bufferedAmount: number;
  send: jest.Mock;
  ping: jest.Mock;
  terminate: jest.Mock;
  on: jest.Mock;
  /** Convenience: fire whichever `'pong'` handler the production code registered. */
  triggerPong: () => void;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
};

function makeClient(): SyntheticClient {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const client: SyntheticClient = {
    readyState: 1, // OPEN
    bufferedAmount: 0,
    send: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      (handlers[event] ||= []).push(handler);
    }),
    triggerPong: () => {
      for (const h of handlers['pong'] ?? []) h();
    },
    handlers,
  };
  return client;
}

/** Run `fn` with CDC_SECRET pinned to `value` (or unset when `null`) and restore the prior value afterwards. */
async function withCdcSecret(value: string | null, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.CDC_SECRET;
  if (value === null) delete process.env.CDC_SECRET;
  else process.env.CDC_SECRET = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CDC_SECRET;
    else process.env.CDC_SECRET = prev;
  }
}

function resetSharedMocks(): void {
  for (const k of Object.keys(wssHandlers)) delete wssHandlers[k];
  wssClients.clear();
  captureMessageMock.mockReset();
}

describe('startCdcDispatcher (BS#1187)', () => {
  // The dispatcher must own LISTEN startup so in-process subscribers
  // (`setupMetadataBroadcast`, future consumers) work whether or not the
  // websocket is configured. This was the silent-failure mode pre-#1187.

  beforeEach(() => {
    jest.clearAllMocks();
    resetSharedMocks();
  });

  it('calls startCdcListener regardless of CDC_SECRET', async () => {
    await withCdcSecret(null, async () => {
      await startCdcDispatcher();
      expect(startCdcListener).toHaveBeenCalledTimes(1);
    });
  });

  it('does not register an onCdcEvent handler itself — that is the consumers job', async () => {
    await startCdcDispatcher();
    expect(onCdcEvent).not.toHaveBeenCalled();
  });

  it('does not start a WebSocketServer', async () => {
    await startCdcDispatcher();
    expect(WebSocketServer).not.toHaveBeenCalled();
  });
});

describe('shutdownCdcDispatcher (BS#1187)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSharedMocks();
  });

  it('calls stopCdcListener', async () => {
    await shutdownCdcDispatcher();
    expect(stopCdcListener).toHaveBeenCalledTimes(1);
  });
});

describe('setupCdcWebSocket (BS#1187)', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetSharedMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('no-ops with the [cdc-ws] disabled log when CDC_SECRET is unset', async () => {
    await withCdcSecret(null, async () => {
      await setupCdcWebSocket(makeServer());

      // Deploy-verification contract: this exact line was preserved across
      // the BS#1187 split so log-tail dashboards keep matching.
      expect(consoleLogSpy).toHaveBeenCalledWith('[cdc-ws] CDC_SECRET not set, CDC WebSocket disabled');
      expect(WebSocketServer).not.toHaveBeenCalled();
      // The decoupling guarantee: the websocket path no longer touches the
      // listener. Regressing this would silently disable in-process
      // subscribers in CDC_SECRET-less environments (the BS#1187 bug).
      expect(startCdcListener).not.toHaveBeenCalled();
      expect(onCdcEvent).not.toHaveBeenCalled();
    });
  });

  it('binds the WebSocketServer and registers a fan-out handler when CDC_SECRET is set', async () => {
    await withCdcSecret('test-secret', async () => {
      const server = makeServer();
      try {
        await setupCdcWebSocket(server);

        expect(WebSocketServer).toHaveBeenCalledTimes(1);
        expect(server.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
        expect(onCdcEvent).toHaveBeenCalledTimes(1);
        expect(startCdcListener).not.toHaveBeenCalled();
      } finally {
        await shutdownCdcWebSocket();
      }
    });
  });
});

describe('shutdownCdcWebSocket (BS#1187)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSharedMocks();
  });

  it('does not call stopCdcListener — the dispatcher owns the LISTEN lifecycle', async () => {
    await shutdownCdcWebSocket();
    expect(stopCdcListener).not.toHaveBeenCalled();
  });
});

/**
 * BS#1134 — back-pressure + native ping/pong.
 *
 * These tests drive the production code's per-client paths by synthesising a
 * `'connection'` event with a `SyntheticClient` and exercising both the
 * heartbeat tick and the fan-out callback registered via `onCdcEvent`.
 */
describe('CDC WebSocket back-pressure and ping/pong (BS#1134)', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetSharedMocks();
    jest.useFakeTimers();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.useRealTimers();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    await shutdownCdcWebSocket();
  });

  /**
   * Drive the captured `onCdcEvent` callback with one fan-out event. The
   * production code registers exactly one callback during `setupCdcWebSocket`.
   */
  function fireFanoutEvent(): void {
    const call = (onCdcEvent as jest.Mock).mock.calls[0];
    expect(call).toBeDefined();
    const fanoutCb = call[0] as (event: unknown) => void;
    fanoutCb({ table: 'flowsheet', schema: 'wxyc_schema', action: 'INSERT', data: {}, timestamp: 0 });
  }

  /** Drive the `'connection'` handler registered on the WebSocketServer. */
  function connectClient(client: SyntheticClient): void {
    wssClients.add(client);
    const connHandlers = wssHandlers['connection'] ?? [];
    expect(connHandlers.length).toBeGreaterThan(0);
    for (const h of connHandlers) h(client, {});
  }

  describe('back-pressure', () => {
    it('terminates a client and skips the send when bufferedAmount exceeds the threshold during fan-out', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);

        // Saturate the outbound buffer beyond the threshold. The exact
        // threshold is private to the module; 2 MB clears 1 MB without
        // hard-coding the constant here.
        client.bufferedAmount = 2 * 1024 * 1024;

        // The initial `'connected'` envelope was already enqueued at
        // connection time — clear that bookkeeping so the assertion below
        // measures only the fan-out path.
        client.send.mockClear();

        fireFanoutEvent();

        expect(client.send).not.toHaveBeenCalled();
        expect(client.terminate).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith(
          expect.stringMatching(/buffered_amount|back.?pressure/i),
          expect.objectContaining({ level: 'warning' })
        );
      });
    });

    it('sends normally when bufferedAmount is below the threshold', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);
        client.bufferedAmount = 0;
        client.send.mockClear();

        fireFanoutEvent();

        expect(client.send).toHaveBeenCalledTimes(1);
        expect(client.terminate).not.toHaveBeenCalled();
      });
    });

    it('terminates a client on the heartbeat tick when bufferedAmount is over the threshold', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);
        // Need a pong on the first tick so the missed-pong policy doesn't
        // pre-empt the back-pressure path.
        client.triggerPong();
        client.bufferedAmount = 2 * 1024 * 1024;
        client.ping.mockClear();

        // Advance to the next heartbeat tick (30s).
        jest.advanceTimersByTime(30_000);

        expect(client.terminate).toHaveBeenCalled();
        expect(client.ping).not.toHaveBeenCalled();
      });
    });
  });

  describe('native ping/pong', () => {
    it('sends a native ping (not an app-level JSON message) on the heartbeat tick', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);
        // Clear the initial `'connected'` envelope so the assertion below
        // measures only what the heartbeat tick produced.
        client.send.mockClear();

        jest.advanceTimersByTime(30_000);

        expect(client.ping).toHaveBeenCalledTimes(1);
        // App-level `{type:'heartbeat'}` payloads must no longer be sent —
        // ping/pong is the wedge-detection channel.
        for (const call of client.send.mock.calls) {
          const payload = String(call[0] ?? '');
          expect(payload).not.toMatch(/"type"\s*:\s*"heartbeat"/);
        }
      });
    });

    it('keeps a client alive across the next heartbeat tick when a pong arrives in between', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);

        // First tick: send ping. Client responds with a pong.
        jest.advanceTimersByTime(30_000);
        expect(client.ping).toHaveBeenCalledTimes(1);
        client.triggerPong();

        // Second tick: still alive, should be pinged again, not terminated.
        jest.advanceTimersByTime(30_000);
        expect(client.terminate).not.toHaveBeenCalled();
        expect(client.ping).toHaveBeenCalledTimes(2);
      });
    });

    it('terminates a client that misses a pong before the next heartbeat tick', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);

        // First tick: pings the client. Client does NOT pong.
        jest.advanceTimersByTime(30_000);
        expect(client.ping).toHaveBeenCalledTimes(1);

        // Second tick: missed pong → terminate.
        jest.advanceTimersByTime(30_000);
        expect(client.terminate).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith(
          expect.stringMatching(/pong|heartbeat/i),
          expect.objectContaining({ level: 'warning' })
        );
      });
    });
  });
});
