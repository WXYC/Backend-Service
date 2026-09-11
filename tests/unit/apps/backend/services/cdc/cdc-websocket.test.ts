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
 *   6. The heartbeat uses native WebSocket ping/pong frames for liveness.
 *      Clients that don't pong before the next heartbeat tick are
 *      terminated with a Sentry warning.
 *   7. The `'pong'` arrival keeps the connection alive across the next
 *      heartbeat tick.
 *
 * BS#2427 addition:
 *   8. The same tick also emits an app-level `{"type":"heartbeat"}` frame,
 *      alongside (never instead of) the native ping, so a consumer that
 *      cannot observe protocol frames still sees traffic on an idle stream.
 *      A client terminated on that tick gets no frame.
 *
 * The metadata-broadcast subscriber's actual filtering is covered in
 * `metadata-broadcast.test.ts`; this file pins the wiring contract that
 * lets it fire in the first place.
 */

jest.mock('@wxyc/database', () => ({
  onCdcEvent: jest.fn(),
  onCdcOversizedEvent: jest.fn(),
  onCdcErrorEvent: jest.fn(),
  startCdcListener: jest.fn().mockResolvedValue(undefined),
  stopCdcListener: jest.fn().mockResolvedValue(undefined),
}));

const captureMessageMock = jest.fn();
jest.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

// Partial-mock `crypto` so the BS#1136 auth test can prove the compare goes
// through `timingSafeEqual` (constant time). The real implementation is
// preserved via `jest.fn(actual.timingSafeEqual)`, so behaviour is unchanged;
// `jest.spyOn` can't be used because `timingSafeEqual` is non-configurable on
// the native module object.
jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    timingSafeEqual: jest.fn(actual.timingSafeEqual),
  };
});

// Captured server-level handlers so tests can drive the `'connection'` event
// against a synthetic client. Reset in `beforeEach`.
const wssHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
const wssClients = new Set<unknown>();
// Shared `handleUpgrade` mock so the BS#1136 auth tests can assert whether a
// given upgrade request was accepted (handleUpgrade called) or rejected.
const wssHandleUpgradeMock = jest.fn();

jest.mock('ws', () => {
  const WebSocketServer = jest.fn().mockImplementation(() => {
    return {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        (wssHandlers[event] ||= []).push(handler);
      },
      close: jest.fn(),
      clients: wssClients,
      handleUpgrade: wssHandleUpgradeMock,
      emit: jest.fn(),
    };
  });
  return {
    WebSocketServer,
    WebSocket: { OPEN: 1 },
  };
});

import type { Server as HttpServer } from 'http';
import { timingSafeEqual } from 'crypto';
import { onCdcErrorEvent, onCdcEvent, onCdcOversizedEvent, startCdcListener, stopCdcListener } from '@wxyc/database';
import { WebSocketServer } from 'ws';
import {
  setupCdcWebSocket,
  shutdownCdcWebSocket,
  constantTimeEqual,
} from '../../../../../../apps/backend/services/cdc/cdc-websocket';
import { startCdcDispatcher, shutdownCdcDispatcher } from '../../../../../../apps/backend/services/cdc/dispatcher';

/**
 * Pinned copies of the back-pressure capture's grouping inputs. Both live
 * in the module under test; duplicating them here is what makes a change to
 * either one a visible test failure rather than a silent regrouping in Sentry.
 */
const BACKPRESSURE_MESSAGE = 'cdc_ws.buffered_amount_high — terminating slow consumer';
const BACKPRESSURE_FINGERPRINT = ['cdc-ws', 'buffered-amount-high'];

/**
 * The app-level heartbeat frame's shape (BS#2427), spelled out rather than
 * re-derived from the implementation because it is the wire contract: this
 * is the pre-BS#1412 shape, and consumers outside this repo parse it. Used
 * with `toEqual`, so a renamed key, a dropped `timestamp`, or an added
 * field all fail here.
 */
const HEARTBEAT_FRAME_SHAPE = { type: 'heartbeat', timestamp: expect.any(Number) };

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
  wssHandleUpgradeMock.mockReset();
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

describe('startCdcDispatcher BS#1120 fallback sinks', () => {
  // BS#1120 / AC #3: migration 0094 emits to `cdc_oversized` and `cdc_error`
  // when the primary `cdc` payload would have been dropped (oversized) or the
  // trigger body raised. The dispatcher's job is to bridge those into Sentry
  // captureMessage calls so the alert hook can fire. Pins:
  //   1. Both channel subscriptions are wired on startCdcDispatcher.
  //   2. An oversized event produces a Sentry.captureMessage('cdc.oversized_payload', ...).
  //   3. A cdc_error event produces a Sentry.captureMessage('cdc.trigger_exception', ...).
  //   4. Double-start does not double-wire (idempotency latch).
  //   5. shutdownCdcDispatcher drops the latch so a re-start re-wires.

  beforeEach(async () => {
    jest.clearAllMocks();
    // Drop any latch left over from a prior describe's startCdcDispatcher call.
    await shutdownCdcDispatcher();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await shutdownCdcDispatcher();
  });

  it('subscribes to both cdc_oversized and cdc_error on dispatcher start', async () => {
    await startCdcDispatcher();
    expect(onCdcOversizedEvent).toHaveBeenCalledTimes(1);
    expect(onCdcErrorEvent).toHaveBeenCalledTimes(1);
  });

  it('captureMessages cdc.oversized_payload with table + action + reason tags when an oversized event arrives', async () => {
    await startCdcDispatcher();
    // The dispatcher registered a callback via onCdcOversizedEvent — pull it
    // out of the mock and invoke it directly.
    const oversizedCb = (onCdcOversizedEvent as jest.Mock).mock.calls[0][0] as (e: unknown) => void;

    oversizedCb({
      table: 'flowsheet',
      schema: 'wxyc_schema',
      action: 'UPDATE',
      primary_key: '42',
      payload_bytes: 8501,
      timestamp: 1_700_000_000_000,
      reason: 'payload_too_large',
    });

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledWith(
      'cdc.oversized_payload',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          subsystem: 'cdc',
          table: 'flowsheet',
          action: 'UPDATE',
          reason: 'payload_too_large',
        }),
        extra: expect.objectContaining({
          schema: 'wxyc_schema',
          primary_key: '42',
          payload_bytes: 8501,
        }),
        fingerprint: ['cdc-oversized-payload'],
      })
    );
  });

  it('captureMessages cdc.trigger_exception with sqlstate tag when a cdc_error event arrives', async () => {
    await startCdcDispatcher();
    const errorCb = (onCdcErrorEvent as jest.Mock).mock.calls[0][0] as (e: unknown) => void;

    errorCb({
      table: 'flowsheet',
      schema: 'wxyc_schema',
      action: 'INSERT',
      sqlstate: '22023',
      sqlerrm: 'invalid_parameter_value',
      timestamp: 1_700_000_000_000,
      reason: 'trigger_exception',
    });

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledWith(
      'cdc.trigger_exception',
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          subsystem: 'cdc',
          table: 'flowsheet',
          action: 'INSERT',
          reason: 'trigger_exception',
          sqlstate: '22023',
        }),
        extra: expect.objectContaining({
          schema: 'wxyc_schema',
          sqlerrm: 'invalid_parameter_value',
        }),
        fingerprint: ['cdc-trigger-exception'],
      })
    );
  });

  it('does not re-wire fallback sinks on a second startCdcDispatcher call (idempotency)', async () => {
    await startCdcDispatcher();
    await startCdcDispatcher();
    // Without the latch, each call would register a fresh sink → 2 captures
    // per inbound event. With the latch, exactly one.
    expect(onCdcOversizedEvent).toHaveBeenCalledTimes(1);
    expect(onCdcErrorEvent).toHaveBeenCalledTimes(1);
  });

  it('shutdownCdcDispatcher drops the latch so a subsequent start re-wires', async () => {
    await startCdcDispatcher();
    await shutdownCdcDispatcher();
    await startCdcDispatcher();
    expect(onCdcOversizedEvent).toHaveBeenCalledTimes(2);
    expect(onCdcErrorEvent).toHaveBeenCalledTimes(2);
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
          BACKPRESSURE_MESSAGE,
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({ tool: 'cdc-ws', step: 'backpressure' }),
            extra: expect.objectContaining({ bufferedAmount: 2 * 1024 * 1024, threshold: 1024 * 1024 }),
            fingerprint: BACKPRESSURE_FINGERPRINT,
          })
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
        // The client is alive (ponged) but backed up — the not-alive-and-
        // backed-up combination is pinned in the BS#2426 block below.
        client.triggerPong();
        client.bufferedAmount = 2 * 1024 * 1024;
        client.ping.mockClear();

        // Advance to the next heartbeat tick (30s).
        jest.advanceTimersByTime(30_000);

        expect(client.terminate).toHaveBeenCalled();
        expect(client.ping).not.toHaveBeenCalled();
        expect(captureMessageMock).toHaveBeenCalledWith(
          BACKPRESSURE_MESSAGE,
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({ tool: 'cdc-ws', step: 'backpressure-heartbeat' }),
            extra: expect.objectContaining({ bufferedAmount: 2 * 1024 * 1024, threshold: 1024 * 1024 }),
            fingerprint: BACKPRESSURE_FINGERPRINT,
          })
        );
        // The verdict names back-pressure, not a missed pong (BS#2426).
        expect(captureMessageMock).not.toHaveBeenCalledWith(expect.stringContaining('missed_pong'), expect.anything());
      });
    });

    // The grouping key must not vary with the live buffer depth: the
    // reconnect storm this capture exists to measure produces a different
    // `bufferedAmount` on every occurrence, so a byte count anywhere in the
    // message or fingerprint splits the signal into one issue per event.
    it('groups every occurrence under one key regardless of buffer depth or which path tripped', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const fanoutClient = makeClient();
        connectClient(fanoutClient);
        fanoutClient.bufferedAmount = 2 * 1024 * 1024;
        fireFanoutEvent();
        // `terminate()` closes the real socket; model that so the heartbeat
        // tick below doesn't re-capture this client as a third occurrence.
        fanoutClient.readyState = 3; // CLOSED

        const heartbeatClient = makeClient();
        connectClient(heartbeatClient);
        heartbeatClient.triggerPong();
        heartbeatClient.bufferedAmount = 7 * 1024 * 1024;
        jest.advanceTimersByTime(30_000);

        const backpressureCalls = captureMessageMock.mock.calls.filter((call) =>
          String(call[0]).includes('buffered_amount_high')
        );
        expect(backpressureCalls).toHaveLength(2);

        const groupingKeys = backpressureCalls.map((call) =>
          JSON.stringify([call[0], (call[1] as { fingerprint?: unknown }).fingerprint])
        );
        expect(new Set(groupingKeys).size).toBe(1);
        for (const [message] of backpressureCalls) {
          expect(String(message)).not.toMatch(/\d/);
        }
      });
    });
  });

  /**
   * BS#2426 — attribution ordering in the heartbeat tick. A ping frame
   * cannot overtake bytes already queued on the same socket, so a consumer
   * buffered past the threshold will also miss its pong round-trip. The
   * back-pressure check must therefore precede the missed-pong verdict:
   * otherwise the slow consumer is terminated as an unresponsive one,
   * re-conflating "slow" with "gone" — the exact split BS#1134 introduced.
   */
  describe('attribution ordering (BS#2426)', () => {
    it('attributes a client that is both backed up and pong-silent to back-pressure, not missed_pong', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);

        // Tick 1 pings and clears the liveness flag. The client never
        // pongs — its outbound buffer is saturated, so the missed pong is
        // a symptom of the back-pressure, not an independent fault.
        jest.advanceTimersByTime(30_000);
        expect(client.ping).toHaveBeenCalledTimes(1);
        client.bufferedAmount = 2 * 1024 * 1024;

        // Tick 2 sees both conditions; the verdict must name the cause an
        // operator can act on.
        jest.advanceTimersByTime(30_000);

        expect(client.terminate).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith(
          BACKPRESSURE_MESSAGE,
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({ tool: 'cdc-ws', step: 'backpressure-heartbeat' }),
          })
        );
        expect(captureMessageMock).not.toHaveBeenCalledWith(expect.stringContaining('missed_pong'), expect.anything());
      });
    });

    it('still attributes a pong-silent client with an empty outbound buffer to missed_pong', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);
        client.bufferedAmount = 0;

        // Tick 1 pings; the client never pongs and nothing is buffered —
        // a genuinely unresponsive consumer, not a slow one.
        jest.advanceTimersByTime(30_000);
        // Tick 2: the missed-pong verdict stands.
        jest.advanceTimersByTime(30_000);

        expect(client.terminate).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith(
          expect.stringContaining('missed_pong'),
          expect.objectContaining({ level: 'warning' })
        );
        expect(captureMessageMock).not.toHaveBeenCalledWith(
          expect.stringContaining('buffered_amount_high'),
          expect.anything()
        );
      });
    });
  });

  describe('native ping/pong', () => {
    it('sends a native ping on the heartbeat tick', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);

        jest.advanceTimersByTime(30_000);

        // The native ping is the wedge-detection channel; the app-level
        // frame that rides the same tick (BS#2427) is not a substitute for
        // it and is asserted separately below.
        expect(client.ping).toHaveBeenCalledTimes(1);
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

  /**
   * BS#2427 — the app-level heartbeat frame, restored alongside the native
   * ping. BS#1412 replaced the frame with ping/pong, which is the right
   * liveness mechanism but is invisible to the browser `WebSocket` API and
   * to any hand-rolled consumer that doesn't speak protocol frames: to them
   * an idle-but-healthy stream became indistinguishable from a dead one.
   */
  describe('app-level heartbeat frame (BS#2427)', () => {
    /** Every payload the client was sent, as strings. */
    function sentPayloads(client: SyntheticClient): string[] {
      return client.send.mock.calls.map((call) => String(call[0] ?? ''));
    }

    /** Every payload the client was sent, parsed. */
    function sentFrames(client: SyntheticClient): unknown[] {
      return sentPayloads(client).map((payload) => JSON.parse(payload));
    }

    it('emits the app-level frame alongside the native ping on each tick', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);
        // Clear the initial `'connected'` envelope so the assertions below
        // measure only what the heartbeat tick produced.
        client.send.mockClear();

        jest.advanceTimersByTime(30_000);

        expect(client.ping).toHaveBeenCalledTimes(1);
        expect(sentFrames(client)).toEqual([HEARTBEAT_FRAME_SHAPE]);

        // The frame rides every tick, not just the first — that is the whole
        // point for a consumer whose watchdog expects traffic within N
        // seconds.
        client.triggerPong();
        jest.advanceTimersByTime(30_000);

        expect(client.ping).toHaveBeenCalledTimes(2);
        expect(sentFrames(client)).toEqual([HEARTBEAT_FRAME_SHAPE, HEARTBEAT_FRAME_SHAPE]);
        expect(client.terminate).not.toHaveBeenCalled();

        // The timestamp advances with the tick. A frame serialized once at
        // module load would satisfy every assertion above and fail this one,
        // handing consumers a clock frozen at process start.
        const [first, second] = sentFrames(client) as { timestamp: number }[];
        expect(second.timestamp - first.timestamp).toBe(30_000);
      });
    });

    it('stamps every client on a tick with the same timestamp', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const first = makeClient();
        const second = makeClient();
        connectClient(first);
        connectClient(second);
        first.send.mockClear();
        second.send.mockClear();

        jest.advanceTimersByTime(30_000);

        // Built once per tick, not once per client: a consumer comparing
        // frames across two connections is reading the tick, not its
        // socket's position in the iteration.
        const [firstFrame] = sentFrames(first) as { timestamp: number }[];
        const [secondFrame] = sentFrames(second) as { timestamp: number }[];
        expect(firstFrame.timestamp).toBe(secondFrame.timestamp);
      });
    });

    it('attributes a termination inside the frame send to the heartbeat, not to fan-out', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);
        client.triggerPong();

        // Exactly at the threshold, so the inline `>` check lets it through;
        // the ping's own bytes then push it over. This is the only path on
        // which the heartbeat terminates a client from inside `safeSend`,
        // and it must not be reported as a fan-out termination — the two
        // step tags are what separate the paths under one fingerprint.
        client.bufferedAmount = 1024 * 1024;
        client.ping.mockImplementation(() => {
          client.bufferedAmount = 2 * 1024 * 1024;
        });

        jest.advanceTimersByTime(30_000);

        expect(client.terminate).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith(
          BACKPRESSURE_MESSAGE,
          expect.objectContaining({
            tags: expect.objectContaining({ tool: 'cdc-ws', step: 'backpressure-heartbeat' }),
            fingerprint: BACKPRESSURE_FINGERPRINT,
          })
        );
        expect(captureMessageMock).not.toHaveBeenCalledWith(
          BACKPRESSURE_MESSAGE,
          expect.objectContaining({ tags: expect.objectContaining({ step: 'backpressure' }) })
        );
      });
    });

    it('does not send the frame to a client terminated on that tick for a missed pong', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);

        // First tick: pinged and framed. The client never pongs.
        jest.advanceTimersByTime(30_000);
        client.send.mockClear();

        // Second tick: the missed-pong check terminates before the frame is
        // reached, so a dying client is not handed one last heartbeat.
        jest.advanceTimersByTime(30_000);

        expect(client.terminate).toHaveBeenCalledTimes(1);
        expect(client.send).not.toHaveBeenCalled();
      });
    });

    it('does not send the frame to a client terminated on that tick for back-pressure', async () => {
      await withCdcSecret('test-secret', async () => {
        await setupCdcWebSocket(makeServer());

        const client = makeClient();
        connectClient(client);
        // Pong so the missed-pong policy doesn't pre-empt the back-pressure
        // path we're pinning here.
        client.triggerPong();
        client.bufferedAmount = 2 * 1024 * 1024;
        client.send.mockClear();

        jest.advanceTimersByTime(30_000);

        expect(client.terminate).toHaveBeenCalled();
        expect(client.send).not.toHaveBeenCalled();
      });
    });
  });
});

/**
 * BS#1136 — constant-time WebSocket auth via the `Authorization: Bearer`
 * header, with a one-deploy `?key=` backwards-compatibility shim.
 *
 * Pins:
 *   (a) the secret compare goes through `crypto.timingSafeEqual` (constant
 *       time), rejects a wrong secret, and never throws on a length mismatch;
 *   (b) a connection presenting the correct secret in an `Authorization:
 *       Bearer` header is accepted (`handleUpgrade` called);
 *   (c) the deprecated `?key=` query-string path still authenticates for one
 *       deploy but emits a deprecation warning; the header wins when both are
 *       present; the bearer secret is never written to any log.
 */
describe('constantTimeEqual (BS#1136)', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('s3cr3t-value-123', 's3cr3t-value-123')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(constantTimeEqual('s3cr3t-value-123', 's3cr3t-value-124')).toBe(false);
  });

  it('returns false (without throwing) when the lengths differ', () => {
    // A naive `crypto.timingSafeEqual` throws on unequal-length buffers; the
    // length guard must swallow that and report a plain non-match.
    expect(() => constantTimeEqual('short', 'a-considerably-longer-secret')).not.toThrow();
    expect(constantTimeEqual('short', 'a-considerably-longer-secret')).toBe(false);
  });

  it('delegates the equal-length compare to crypto.timingSafeEqual', () => {
    (timingSafeEqual as jest.Mock).mockClear();
    constantTimeEqual('s3cr3t-value-123', 's3cr3t-value-123');
    expect(timingSafeEqual as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('does not reach crypto.timingSafeEqual on a length mismatch (guards before the call)', () => {
    (timingSafeEqual as jest.Mock).mockClear();
    expect(constantTimeEqual('short', 'a-considerably-longer-secret')).toBe(false);
    expect(timingSafeEqual as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('CDC WebSocket upgrade auth (BS#1136)', () => {
  const SECRET = 'super-secret-cdc-value';
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetSharedMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    await shutdownCdcWebSocket();
  });

  /** Pull the `'upgrade'` handler `setupCdcWebSocket` registered on the HTTP server. */
  function getUpgradeHandler(server: HttpServer): (req: unknown, socket: unknown, head: unknown) => void {
    const call = (server.on as jest.Mock).mock.calls.find((c) => c[0] === 'upgrade');
    expect(call).toBeDefined();
    return call![1] as (req: unknown, socket: unknown, head: unknown) => void;
  }

  function makeUpgradeRequest(opts: { authorization?: string; query?: string }): unknown {
    return {
      url: `/cdc${opts.query ?? ''}`,
      headers: {
        host: 'localhost:8080',
        ...(opts.authorization ? { authorization: opts.authorization } : {}),
      },
    };
  }

  function makeSocket(): { write: jest.Mock; destroy: jest.Mock } {
    return { write: jest.fn(), destroy: jest.fn() };
  }

  it('accepts a connection authenticated via the Authorization: Bearer header', async () => {
    await withCdcSecret(SECRET, async () => {
      const server = makeServer();
      await setupCdcWebSocket(server);
      const handler = getUpgradeHandler(server);
      const socket = makeSocket();

      handler(makeUpgradeRequest({ authorization: `Bearer ${SECRET}` }), socket, Buffer.alloc(0));

      expect(wssHandleUpgradeMock).toHaveBeenCalledTimes(1);
      expect(socket.destroy).not.toHaveBeenCalled();
    });
  });

  it('accepts a Bearer header whose scheme/token separator is a tab or multiple spaces (RFC 7235 1*SP)', async () => {
    await withCdcSecret(SECRET, async () => {
      const server = makeServer();
      await setupCdcWebSocket(server);
      const handler = getUpgradeHandler(server);

      for (const sep of ['\t', '  ', ' \t ']) {
        wssHandleUpgradeMock.mockClear();
        const socket = makeSocket();
        handler(makeUpgradeRequest({ authorization: `Bearer${sep}${SECRET}` }), socket, Buffer.alloc(0));
        expect(wssHandleUpgradeMock).toHaveBeenCalledTimes(1);
        expect(socket.destroy).not.toHaveBeenCalled();
      }
    });
  });

  it('rejects a wrong Bearer secret without calling handleUpgrade', async () => {
    await withCdcSecret(SECRET, async () => {
      const server = makeServer();
      await setupCdcWebSocket(server);
      const handler = getUpgradeHandler(server);
      const socket = makeSocket();

      handler(makeUpgradeRequest({ authorization: 'Bearer not-the-secret' }), socket, Buffer.alloc(0));

      expect(wssHandleUpgradeMock).not.toHaveBeenCalled();
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403'));
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects a request that carries no credentials', async () => {
    await withCdcSecret(SECRET, async () => {
      const server = makeServer();
      await setupCdcWebSocket(server);
      const handler = getUpgradeHandler(server);
      const socket = makeSocket();

      handler(makeUpgradeRequest({}), socket, Buffer.alloc(0));

      expect(wssHandleUpgradeMock).not.toHaveBeenCalled();
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    });
  });

  it('never writes the bearer secret to a log line', async () => {
    await withCdcSecret(SECRET, async () => {
      const server = makeServer();
      await setupCdcWebSocket(server);
      const handler = getUpgradeHandler(server);

      handler(makeUpgradeRequest({ authorization: 'Bearer leak-me-if-you-can' }), makeSocket(), Buffer.alloc(0));

      const logged = [...consoleWarnSpy.mock.calls, ...consoleLogSpy.mock.calls].flat().map(String).join(' ');
      expect(logged).not.toContain('leak-me-if-you-can');
    });
  });

  describe('deprecated ?key= backwards-compatibility shim', () => {
    it('still accepts the correct secret supplied in the query string', async () => {
      await withCdcSecret(SECRET, async () => {
        const server = makeServer();
        await setupCdcWebSocket(server);
        const handler = getUpgradeHandler(server);
        const socket = makeSocket();

        handler(makeUpgradeRequest({ query: `?key=${SECRET}` }), socket, Buffer.alloc(0));

        expect(wssHandleUpgradeMock).toHaveBeenCalledTimes(1);
        expect(socket.destroy).not.toHaveBeenCalled();
      });
    });

    it('emits a deprecation warning when the query-string path is used', async () => {
      await withCdcSecret(SECRET, async () => {
        const server = makeServer();
        await setupCdcWebSocket(server);
        const handler = getUpgradeHandler(server);

        handler(makeUpgradeRequest({ query: `?key=${SECRET}` }), makeSocket(), Buffer.alloc(0));

        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringMatching(/deprecat/i));
      });
    });

    it('rejects a wrong secret supplied in the query string', async () => {
      await withCdcSecret(SECRET, async () => {
        const server = makeServer();
        await setupCdcWebSocket(server);
        const handler = getUpgradeHandler(server);
        const socket = makeSocket();

        handler(makeUpgradeRequest({ query: '?key=wrong' }), socket, Buffer.alloc(0));

        expect(wssHandleUpgradeMock).not.toHaveBeenCalled();
        expect(socket.destroy).toHaveBeenCalledTimes(1);
      });
    });

    it('prefers the Authorization header over the query string (no deprecation warning)', async () => {
      await withCdcSecret(SECRET, async () => {
        const server = makeServer();
        await setupCdcWebSocket(server);
        const handler = getUpgradeHandler(server);
        const socket = makeSocket();

        // Correct header + wrong query → accepted on the header, and the
        // deprecated-path warning must not fire because ?key= was never read.
        handler(
          makeUpgradeRequest({ authorization: `Bearer ${SECRET}`, query: '?key=wrong' }),
          socket,
          Buffer.alloc(0)
        );

        expect(wssHandleUpgradeMock).toHaveBeenCalledTimes(1);
        expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/deprecat/i));
      });
    });
  });
});
