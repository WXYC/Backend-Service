import { EventEmitter } from 'events';

// Mock the metrics module so the ServerEventsManager → sse-metrics hooks
// don't try to talk to CloudWatch (no `SSE_METRICS_DISABLED` env in tests).
jest.mock('../../../apps/backend/services/sse/sse-metrics', () => ({
  recordBroadcast: jest.fn(),
  recordBroadcastFailure: jest.fn(),
}));

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

import * as Sentry from '@sentry/node';
import { ServerEventsManager } from '../../../apps/backend/utils/serverEvents';
import { recordBroadcast, recordBroadcastFailure } from '../../../apps/backend/services/sse/sse-metrics';
import { Response } from 'express';

function createMockResponse(): Response {
  const emitter = new EventEmitter();
  const res = {
    writeHead: jest.fn(),
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as Response;
  return res;
}

describe('ServerEventsManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('heartbeat (BS#1130)', () => {
    const HEARTBEAT_FRAME = ': keepalive\n\n';
    const HEARTBEAT_INTERVAL_MS = 30 * 1000;

    beforeEach(() => {
      (Sentry.captureException as jest.Mock).mockClear();
    });

    it('writes a SSE comment heartbeat every 30 seconds', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      mgr.registerClient(res);

      const writeMock = res.write as jest.Mock;
      // Discard the initial connection-established frame so we count only heartbeats.
      writeMock.mockClear();

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(writeMock).toHaveBeenCalledWith(HEARTBEAT_FRAME);
      expect(writeMock).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(2 * HEARTBEAT_INTERVAL_MS);
      expect(writeMock).toHaveBeenCalledTimes(3);
      expect(writeMock).toHaveBeenNthCalledWith(2, HEARTBEAT_FRAME);
      expect(writeMock).toHaveBeenNthCalledWith(3, HEARTBEAT_FRAME);
    });

    it('keeps a quiet-topic client connected indefinitely while heartbeats are flowing', () => {
      const mgr = new ServerEventsManager('quiet-topic');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['quiet-topic'], client.id);

      // Two hours of silence on the topic — no broadcast, no dispatch.
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);

      expect(res.end).not.toHaveBeenCalled();
      expect(mgr.getSubs(client.id)).toEqual(['quiet-topic']);
    });

    it('stops the heartbeat after the client disconnects', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);

      mgr.disconnect(client.id);

      const writeMock = res.write as jest.Mock;
      writeMock.mockClear();

      jest.advanceTimersByTime(5 * HEARTBEAT_INTERVAL_MS);

      expect(writeMock).not.toHaveBeenCalledWith(HEARTBEAT_FRAME);
    });

    it('cleans up the client when the heartbeat write fails (half-dead socket)', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      const failure = new Error('write after end');
      (res.write as jest.Mock).mockImplementation((frame: string) => {
        if (frame === HEARTBEAT_FRAME) throw failure;
        return true;
      });

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(Sentry.captureException).toHaveBeenCalledWith(
        failure,
        expect.objectContaining({
          tags: expect.objectContaining({ subsystem: 'sse', op: 'heartbeat' }),
          extra: expect.objectContaining({ client_id: client.id }),
        })
      );
      expect(mgr.getSubs(client.id)).toEqual([]);
    });
  });

  describe('CloudWatch metrics hooks', () => {
    beforeEach(() => {
      (recordBroadcast as jest.Mock).mockClear();
      (recordBroadcastFailure as jest.Mock).mockClear();
    });

    it('records one broadcast per call to broadcast(), regardless of subscriber count', () => {
      const mgr = new ServerEventsManager('topic-a');
      const r1 = createMockResponse();
      const r2 = createMockResponse();
      const c1 = mgr.registerClient(r1);
      const c2 = mgr.registerClient(r2);
      mgr.subscribe(['topic-a'], c1.id);
      mgr.subscribe(['topic-a'], c2.id);

      mgr.broadcast('topic-a', { type: 'update', payload: {} });
      mgr.broadcast('topic-a', { type: 'update', payload: {} });

      // 2 broadcasts × 2 subscribers = 4 writes, but only 2 recordBroadcast calls.
      expect(recordBroadcast).toHaveBeenCalledTimes(2);
      expect(recordBroadcast).toHaveBeenCalledWith('topic-a');
      expect(recordBroadcastFailure).not.toHaveBeenCalled();
    });

    it('records a broadcast even when the topic has zero subscribers', () => {
      const mgr = new ServerEventsManager('topic-a');
      mgr.broadcast('topic-a', { type: 'update', payload: {} });
      expect(recordBroadcast).toHaveBeenCalledTimes(1);
    });

    it('records one failure per per-client write failure inside broadcast()', () => {
      const mgr = new ServerEventsManager('topic-a');
      const r1 = createMockResponse();
      const r2 = createMockResponse();
      const c1 = mgr.registerClient(r1);
      const c2 = mgr.registerClient(r2);
      mgr.subscribe(['topic-a'], c1.id);
      mgr.subscribe(['topic-a'], c2.id);

      // r1 writes throw; r2 succeeds.
      (r1.write as jest.Mock).mockImplementation(() => {
        throw new Error('socket closed');
      });

      mgr.broadcast('topic-a', { type: 'update', payload: {} });

      expect(recordBroadcastFailure).toHaveBeenCalledTimes(1);
      expect(recordBroadcastFailure).toHaveBeenCalledWith('topic-a');
    });

    it('records a failure when dispatch() hits a write error', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      // Reset the broadcast counter (subscribe does not broadcast — confirm).
      (recordBroadcast as jest.Mock).mockClear();

      (res.write as jest.Mock).mockImplementation(() => {
        throw new Error('socket closed');
      });

      mgr.dispatch('topic-a', client.id, { type: 'ping', payload: {} });

      expect(recordBroadcastFailure).toHaveBeenCalledTimes(1);
      expect(recordBroadcastFailure).toHaveBeenCalledWith('topic-a');
      // dispatch() is single-client; it does not count as an EventsBroadcast.
      expect(recordBroadcast).not.toHaveBeenCalled();
    });
  });

  describe('Sentry capture on write failure (BS-4)', () => {
    beforeEach(() => {
      (Sentry.captureException as jest.Mock).mockClear();
      (recordBroadcastFailure as jest.Mock).mockClear();
    });

    it('captures broadcast write exceptions to Sentry with topic + client_id', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      const failure = new Error('socket closed');
      (res.write as jest.Mock).mockImplementation(() => {
        throw failure;
      });

      mgr.broadcast('topic-a', { type: 'update', payload: {} });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      const [err, context] = (Sentry.captureException as jest.Mock).mock.calls[0];
      expect(err).toBe(failure);
      expect(context).toMatchObject({
        tags: expect.objectContaining({ subsystem: 'sse', op: 'broadcast', topic: 'topic-a' }),
        extra: expect.objectContaining({ client_id: client.id }),
      });
    });

    it('captures dispatch write exceptions to Sentry with topic + client_id', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      (res.write as jest.Mock).mockImplementation(() => {
        throw new Error('EPIPE');
      });

      mgr.dispatch('topic-a', client.id, { type: 'ping', payload: {} });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      const [, context] = (Sentry.captureException as jest.Mock).mock.calls[0];
      expect(context).toMatchObject({
        tags: expect.objectContaining({ subsystem: 'sse', op: 'dispatch', topic: 'topic-a' }),
        extra: expect.objectContaining({ client_id: client.id }),
      });
    });

    it('does not capture anything on a successful broadcast', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      mgr.broadcast('topic-a', { type: 'update', payload: {} });

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('Sentry capture and the CloudWatch counter both fire on the same write failure', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      (res.write as jest.Mock).mockImplementation(() => {
        throw new Error('write after end');
      });

      mgr.broadcast('topic-a', { type: 'update', payload: {} });

      expect(recordBroadcastFailure).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerClient close-before-insert race (BS#1128)', () => {
    // Build a mock Response whose `write` synchronously emits `close`,
    // mimicking a TCP RST that arrives between the close-handler attach
    // and the final `this.clients.set(client.id, client)` insertion.
    function createMockResponseClosingOnWrite(): Response {
      const emitter = new EventEmitter();
      const res = {
        writeHead: jest.fn(),
        write: jest.fn().mockImplementation(() => {
          // Fire 'close' synchronously during writeHead/write — i.e. while
          // registerClient is still mid-function, before clients.set runs.
          emitter.emit('close');
          return true;
        }),
        end: jest.fn(),
        on: emitter.on.bind(emitter),
        emit: emitter.emit.bind(emitter),
      } as unknown as Response;
      return res;
    }

    it('does not leave a dead client in the clients map when close fires before insert', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponseClosingOnWrite();
      const client = mgr.registerClient(res);

      // If the race is fixed, the close handler observed the client in the
      // map and removed it, OR the client was never inserted at all.
      // Either way, a subscribe call must fail with a 404-style WxycError.
      expect(() => mgr.subscribe(['topic-a'], client.id)).toThrow(/not found/i);
    });

    it('disconnect() of a raced client is a no-op (entry was already cleaned up)', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponseClosingOnWrite();
      const client = mgr.registerClient(res);

      // If the dead client leaked into `clients`, disconnect() would find
      // it and call `res.end()`. With the race fixed, the close handler
      // already removed it (or it was never inserted), so end is untouched.
      const endMock = res.end as jest.Mock;
      endMock.mockClear();
      mgr.disconnect(client.id);
      expect(endMock).not.toHaveBeenCalled();
    });
  });

  describe('getClientCountByTopic', () => {
    it('returns a count of subscribed clients per topic', () => {
      const mgr = new ServerEventsManager('topic-a', 'topic-b');
      const r1 = createMockResponse();
      const r2 = createMockResponse();
      const r3 = createMockResponse();
      const c1 = mgr.registerClient(r1);
      const c2 = mgr.registerClient(r2);
      const c3 = mgr.registerClient(r3);
      mgr.subscribe(['topic-a'], c1.id);
      mgr.subscribe(['topic-a', 'topic-b'], c2.id);
      mgr.subscribe(['topic-b'], c3.id);

      const counts = mgr.getClientCountByTopic();
      expect(counts.get('topic-a')).toBe(2);
      expect(counts.get('topic-b')).toBe(2);
    });

    it('omits topics with zero subscribers (the dimensionless companion carries the alarm input)', () => {
      const mgr = new ServerEventsManager('topic-a', 'topic-b');
      const res = createMockResponse();
      const c = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], c.id);

      const counts = mgr.getClientCountByTopic();
      expect(counts.has('topic-a')).toBe(true);
      expect(counts.has('topic-b')).toBe(false);
    });

    it('returns an empty map when no clients are connected', () => {
      const mgr = new ServerEventsManager('topic-a');
      expect(mgr.getClientCountByTopic().size).toBe(0);
    });
  });
});
