import { Request, Response } from 'express';

jest.mock('../../../apps/backend/utils/serverEvents', () => {
  const Topics = {
    test: 'test-topic',
    primaryDj: 'prim-dj-topic',
    showDj: 'show-dj-topic',
    liveFs: 'live-fs-topic',
    mirror: 'mirror-topic',
  };

  return {
    Topics,
    TestEvents: { test: 'test' },
    serverEventsMgr: {
      registerClient: jest.fn().mockReturnValue({ id: 'client-1' }),
      subscribe: jest.fn().mockReturnValue([]),
    },
  };
});

import { registerEventClient } from '../../../apps/backend/controllers/events.conroller';
import { serverEventsMgr, Topics } from '../../../apps/backend/utils/serverEvents';

describe('events controller', () => {
  describe('registerEventClient', () => {
    it('includes DJ-only topics when the user is authenticated', () => {
      const req = {
        auth: { id: 'user-1', role: 'dj' },
        body: { topics: [Topics.liveFs, Topics.showDj, Topics.primaryDj] },
      } as unknown as Request;

      const res = {} as Response;
      const next = jest.fn();

      registerEventClient(req, res, next);

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([Topics.showDj, Topics.primaryDj]),
        'client-1',
      );
    });

    it('excludes DJ-only topics when the user is unauthenticated', () => {
      const req = {
        body: { topics: [Topics.liveFs, Topics.showDj, Topics.primaryDj] },
      } as unknown as Request;

      const res = {} as Response;
      const next = jest.fn();

      registerEventClient(req, res, next);

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.not.arrayContaining([Topics.showDj, Topics.primaryDj]),
        'client-1',
      );
    });
  });
});
