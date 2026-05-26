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

  describe('inactivity timeout', () => {
    it('disconnects an idle client after 5 minutes', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const _client = mgr.registerClient(res);

      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(res.end).toHaveBeenCalled();
    });

    it('resets the timeout when a broadcast is sent to the client', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      // Advance 4.5 minutes (not yet at 5-min threshold)
      jest.advanceTimersByTime(4.5 * 60 * 1000);

      // Broadcast — this should reset the inactivity timer
      mgr.broadcast('topic-a', { type: 'update', payload: { value: 1 } });

      // Advance another 4.5 minutes (9 min total from registration,
      // but only 4.5 min since last activity)
      jest.advanceTimersByTime(4.5 * 60 * 1000);

      // Client should still be connected because the timer was reset
      expect(res.end).not.toHaveBeenCalled();
      expect(mgr.getSubs(client.id)).toEqual(['topic-a']);
    });

    it('resets the timeout when a dispatch is sent to the client', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      jest.advanceTimersByTime(4.5 * 60 * 1000);

      mgr.dispatch('topic-a', client.id, { type: 'ping', payload: {} });

      jest.advanceTimersByTime(4.5 * 60 * 1000);

      expect(res.end).not.toHaveBeenCalled();
      expect(mgr.getSubs(client.id)).toEqual(['topic-a']);
    });

    it('still disconnects if no activity occurs after the reset window', () => {
      const mgr = new ServerEventsManager('topic-a');
      const res = createMockResponse();
      const client = mgr.registerClient(res);
      mgr.subscribe(['topic-a'], client.id);

      jest.advanceTimersByTime(2 * 60 * 1000);
      mgr.broadcast('topic-a', { type: 'update', payload: {} });

      // Full 5 minutes after the broadcast with no further activity
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('CloudWatch metrics hooks (BS-3)', () => {
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
