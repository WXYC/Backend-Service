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

import { registerEventClient, subscribeToTopic } from '../../../apps/backend/controllers/events.controller';
import { serverEventsMgr, Topics } from '../../../apps/backend/utils/serverEvents';

describe('events controller', () => {
  beforeEach(() => {
    (serverEventsMgr.subscribe as jest.Mock).mockClear();
  });

  describe('registerEventClient', () => {
    it('includes DJ-only topics when the caller has the dj role', () => {
      const req = {
        auth: { id: 'user-1', role: 'dj' },
        body: { topics: [Topics.liveFs, Topics.showDj, Topics.primaryDj] },
      } as unknown as Request;

      const res = {} as Response;
      const next = jest.fn();

      registerEventClient(req, res, next);

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([Topics.showDj, Topics.primaryDj]),
        'client-1'
      );
    });

    it('includes DJ-only topics for roles above dj (musicDirector, stationManager)', () => {
      for (const role of ['musicDirector', 'stationManager']) {
        (serverEventsMgr.subscribe as jest.Mock).mockClear();
        const req = {
          auth: { id: 'user-1', role },
          body: { topics: [Topics.showDj, Topics.primaryDj] },
        } as unknown as Request;

        const res = {} as Response;
        const next = jest.fn();

        registerEventClient(req, res, next);

        expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
          expect.arrayContaining([Topics.showDj, Topics.primaryDj]),
          'client-1'
        );
      }
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
        'client-1'
      );
    });

    it('excludes DJ-only topics when the caller has the member role (BS#1104)', () => {
      // Pre-fix: filterAuthorizedTopics returned every topic in TopicAuthz as
      // long as !!req.auth was truthy — the role list was never consulted.
      // A member-role user could subscribe to `mirror`, `primaryDj`,
      // `showDj`.
      const req = {
        auth: { id: 'user-1', role: 'member' },
        body: { topics: [Topics.liveFs, Topics.showDj, Topics.primaryDj, Topics.mirror] },
      } as unknown as Request;

      const res = {} as Response;
      const next = jest.fn();

      registerEventClient(req, res, next);

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.not.arrayContaining([Topics.showDj, Topics.primaryDj, Topics.mirror]),
        'client-1'
      );
      // Public topics still allowed.
      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(expect.arrayContaining([Topics.liveFs]), 'client-1');
    });
  });

  describe('subscribeToTopic (BS#1104)', () => {
    function makeRes() {
      const statusMock = jest.fn().mockReturnThis();
      const jsonMock = jest.fn().mockReturnThis();
      return { status: statusMock, json: jsonMock } as unknown as Response;
    }

    it('filters DJ-only topics out when the caller has the member role', () => {
      // Pre-fix: subscribeToTopic skipped filterAuthorizedTopics entirely
      // and called serverEventsMgr.subscribe with the raw body topics.
      const req = {
        auth: { id: 'user-1', role: 'member' },
        body: { client_id: 'client-1', topics: [Topics.liveFs, Topics.mirror, Topics.primaryDj] },
      } as unknown as Request;

      subscribeToTopic(req, makeRes(), jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.not.arrayContaining([Topics.mirror, Topics.primaryDj]),
        'client-1'
      );
    });

    it('allows DJ-only topics when the caller has the dj role', () => {
      const req = {
        auth: { id: 'user-1', role: 'dj' },
        body: { client_id: 'client-1', topics: [Topics.mirror, Topics.primaryDj, Topics.showDj] },
      } as unknown as Request;

      subscribeToTopic(req, makeRes(), jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([Topics.mirror, Topics.primaryDj, Topics.showDj]),
        'client-1'
      );
    });

    it('still allows public topics for any authenticated caller', () => {
      const req = {
        auth: { id: 'user-1', role: 'member' },
        body: { client_id: 'client-1', topics: [Topics.liveFs, Topics.test] },
      } as unknown as Request;

      subscribeToTopic(req, makeRes(), jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([Topics.liveFs, Topics.test]),
        'client-1'
      );
    });
  });
});
