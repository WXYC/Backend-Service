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

import {
  registerEventClient,
  subscribeToTopic,
  streamEventClient,
} from '../../../apps/backend/controllers/events.controller';
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

  describe('streamEventClient (GET /events/stream)', () => {
    // GET /events/stream is the EventSource-friendly counterpart to POST
    // /events/register: same registerClient + filterAuthorizedTopics +
    // subscribe pipeline, but topics arrive as a comma-separated `?topics=`
    // query string instead of a JSON body. Browsers' native EventSource
    // can't set custom headers or send a body — the GET-with-query shape
    // is what dj-site's listener middleware speaks.

    it('parses comma-separated topics from the query string and subscribes', () => {
      const req = {
        query: { topics: `${Topics.liveFs},${Topics.test}` },
      } as unknown as Request;

      const res = {} as Response;
      const next = jest.fn();

      streamEventClient(req, res, next);

      expect(serverEventsMgr.registerClient).toHaveBeenCalledWith(res);
      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([Topics.liveFs, Topics.test]),
        'client-1'
      );
    });

    it('subscribes to no topics when the query is missing', () => {
      const req = { query: {} } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith([], 'client-1');
    });

    it('allows public topics for unauthenticated callers (the liveFs path)', () => {
      const req = {
        query: { topics: Topics.liveFs },
      } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(expect.arrayContaining([Topics.liveFs]), 'client-1');
    });

    it('drops DJ-tier topics for unauthenticated callers (the EventSource path has no Authorization header)', () => {
      const req = {
        query: { topics: `${Topics.liveFs},${Topics.showDj},${Topics.mirror}` },
      } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.not.arrayContaining([Topics.showDj, Topics.mirror]),
        'client-1'
      );
      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(expect.arrayContaining([Topics.liveFs]), 'client-1');
    });

    it('drops DJ-tier topics when the caller has the member role (parity with POST /register)', () => {
      const req = {
        auth: { id: 'user-1', role: 'member' },
        query: { topics: `${Topics.liveFs},${Topics.showDj},${Topics.mirror}` },
      } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.not.arrayContaining([Topics.showDj, Topics.mirror]),
        'client-1'
      );
    });

    it('includes DJ-tier topics when the caller has the dj role (still works for authenticated EventSource clients)', () => {
      const req = {
        auth: { id: 'user-1', role: 'dj' },
        query: { topics: `${Topics.liveFs},${Topics.showDj}` },
      } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([Topics.liveFs, Topics.showDj]),
        'client-1'
      );
    });

    it('silently drops topic strings that are not in TopicAuthz', () => {
      const req = {
        query: { topics: `${Topics.liveFs},does-not-exist` },
      } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.not.arrayContaining(['does-not-exist']),
        'client-1'
      );
    });

    it('trims whitespace around comma-separated topic values', () => {
      // Tolerate `?topics=live-fs-topic, test-topic` from hand-typed URLs.
      const req = {
        query: { topics: ` ${Topics.liveFs} , ${Topics.test} ` },
      } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([Topics.liveFs, Topics.test]),
        'client-1'
      );
    });

    it('ignores a non-string topics query parameter (e.g. repeated ?topics=&topics= produces an array)', () => {
      // Express parses repeated query params into an array. The contract
      // is a single comma-separated string, so anything else short-circuits
      // to an empty subscription rather than crashing.
      const req = {
        query: { topics: [Topics.liveFs, Topics.test] },
      } as unknown as Request;

      streamEventClient(req, {} as Response, jest.fn());

      expect(serverEventsMgr.subscribe).toHaveBeenCalledWith([], 'client-1');
    });
  });
});
