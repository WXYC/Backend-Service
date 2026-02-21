import { EventEmitter } from 'events';
import { ServerEventsManager, Topics } from '../../../apps/backend/utils/serverEvents';
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
      const client = mgr.registerClient(res);

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
});
