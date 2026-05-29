/**
 * Unit tests for the CDC dispatcher / websocket split (BS#1187).
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
 * The metadata-broadcast subscriber's actual filtering is covered in
 * `metadata-broadcast.test.ts`; this file pins the wiring contract that
 * lets it fire in the first place.
 */

jest.mock('@wxyc/database', () => ({
  onCdcEvent: jest.fn(),
  startCdcListener: jest.fn().mockResolvedValue(undefined),
  stopCdcListener: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('ws', () => {
  const onMock = jest.fn();
  const closeMock = jest.fn();
  const WebSocketServer = jest.fn().mockImplementation(() => ({
    on: onMock,
    close: closeMock,
    clients: new Set(),
    handleUpgrade: jest.fn(),
    emit: jest.fn(),
  }));
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

describe('startCdcDispatcher (BS#1187)', () => {
  // The dispatcher must own LISTEN startup so in-process subscribers
  // (`setupMetadataBroadcast`, future consumers) work whether or not the
  // websocket is configured. This was the silent-failure mode pre-#1187.

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls startCdcListener regardless of CDC_SECRET', async () => {
    const prev = process.env.CDC_SECRET;
    delete process.env.CDC_SECRET;
    try {
      await startCdcDispatcher();
      expect(startCdcListener).toHaveBeenCalledTimes(1);
    } finally {
      if (prev !== undefined) process.env.CDC_SECRET = prev;
    }
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
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('no-ops with the [cdc-ws] disabled log when CDC_SECRET is unset', async () => {
    const prev = process.env.CDC_SECRET;
    delete process.env.CDC_SECRET;
    try {
      await setupCdcWebSocket(makeServer());

      // Deploy-verification contract: this exact line was preserved across
      // the BS#1187 split so log-tail dashboards keep matching.
      expect(consoleLogSpy).toHaveBeenCalledWith('[cdc-ws] CDC_SECRET not set, CDC WebSocket disabled');
      expect(WebSocketServer).not.toHaveBeenCalled();
      // The decoupling guarantee: the websocket path no longer touches the
      // listener. If this assertion regresses, in-process subscribers will
      // silently lose events in CDC_SECRET-less environments — the exact
      // bug BS#1187 fixed.
      expect(startCdcListener).not.toHaveBeenCalled();
      expect(onCdcEvent).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.CDC_SECRET = prev;
    }
  });

  it('binds the WebSocketServer and registers a fan-out handler when CDC_SECRET is set', async () => {
    const prev = process.env.CDC_SECRET;
    process.env.CDC_SECRET = 'test-secret';
    try {
      const server = makeServer();
      await setupCdcWebSocket(server);

      expect(WebSocketServer).toHaveBeenCalledTimes(1);
      expect(server.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
      // The fan-out handler — the websocket's only consumer of the shared
      // dispatcher. LISTEN startup itself stays in the dispatcher.
      expect(onCdcEvent).toHaveBeenCalledTimes(1);
      expect(startCdcListener).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) {
        process.env.CDC_SECRET = prev;
      } else {
        delete process.env.CDC_SECRET;
      }
      await shutdownCdcWebSocket();
    }
  });
});

describe('shutdownCdcWebSocket (BS#1187)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not call stopCdcListener — the dispatcher owns the LISTEN lifecycle', async () => {
    await shutdownCdcWebSocket();
    expect(stopCdcListener).not.toHaveBeenCalled();
  });
});
