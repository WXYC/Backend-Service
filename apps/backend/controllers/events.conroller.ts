import { Request, RequestHandler } from 'express';
import { serverEventsMgr, TestEvents, Topics, type EventData } from '../utils/serverEvents';

// Role constants for event authorization
const ROLE_DJ = 'dj';

// Define access levels for events
// Empty array = public access, array with roles = requires one of those roles
const TopicAuthz: Record<string, string[]> = {
  [Topics.test]: [],
  [Topics.liveFs]: [],
  [Topics.showDj]: [ROLE_DJ],
  [Topics.primaryDj]: [ROLE_DJ],
  [Topics.mirror]: [ROLE_DJ],
};

const filterAuthorizedTopics = (req: Request, topics: string[]) => {
  const hasAuth = !!req.auth;

  return topics.filter((topic) => {
    if (TopicAuthz[topic] === undefined) return false;
    if (!TopicAuthz[topic].length) return true;
    return hasAuth;
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
    return res.status(400).json({
      message: 'Bad Request: client_id or topics missing from request body',
    });
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
