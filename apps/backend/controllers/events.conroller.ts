import { serverEventsMgr, Topics, EventData, TestEvents } from '@wxyc/shared';
import { RequestHandler, Response } from 'express';
import WxycError from '@wxyc/shared';
import { getUserRole, hasRole } from '@wxyc/auth-middleware';

const TopicAuthz: Record<string, string[]> = {
  [Topics.test]: [],
  [Topics.liveFs]: [],
  [Topics.showDj]: ['dj'],
  [Topics.primaryDj]: ['dj'],
  [Topics.mirror]: ['music-director'],
};

const filterAuthorizedTopics = (req: any, topics: string[]) => {
  const user = req.user;
  
  const userRole = getUserRole(user);

  return topics.filter((topic) => {
    if (TopicAuthz[topic] === undefined) return false;
    if (!TopicAuthz[topic].length) return true;
    return hasRole(userRole, TopicAuthz[topic] as any);
  });
};

type regReqBody = {
  topics?: string[];
};

export const registerEventClient: RequestHandler<object, unknown, regReqBody> = (req, res) => {
  const client = serverEventsMgr.registerClient(res);

  const topics = filterAuthorizedTopics(req, req.body.topics || []);

  serverEventsMgr.subscribe(topics, client.id);
};

type subReqBody = {
  client_id: string;
  topics: string[];
};

export const subscribeToTopic: RequestHandler<object, unknown, subReqBody> = (req, res, next) => {
  const { client_id, topics } = req.body;

  if (!client_id || !topics) {
    return res.status(400).json({ message: 'Bad Request: client_id or topics missing from request body' });
  }

  try {
    const subbedTopics = serverEventsMgr.subscribe(topics, client_id);

    res.status(200).json({ message: 'successfully subscribed', topics: subbedTopics });
  } catch (e) {
    console.error('Failed to subscribe to event: ', e);

    return next(e);
  }
};

export const testTrigger: RequestHandler = (req, res, next) => {
  const data: EventData = {
    type: TestEvents.test,
    payload: {
      message: 'This is a test message sent over sse',
    },
    timestamp: new Date(),
  };

  try {
    serverEventsMgr.broadcast(Topics.test, data);
  } catch (e) {
    console.error('Failed to broadcast event: ', e);

    return next(e);
  }

  res.status(200).json({
    message: 'event triggered',
  });
};
