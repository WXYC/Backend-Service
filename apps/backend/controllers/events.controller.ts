import { Request, RequestHandler } from 'express';
import { serverEventsMgr, TestEvents, Topics, type EventData } from '../utils/serverEvents';
import WxycError from '../utils/error.js';

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

const filterAuthorizedTopics = (req: Pick<Request, 'auth'>, topics: string[]) => {
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

export const subscribeToTopic: RequestHandler<object, unknown, subReqBody> = (req, res) => {
  const { client_id, topics } = req.body;

  if (!client_id || !topics) {
    throw new WxycError('Bad Request: client_id or topics missing from request body', 400);
  }

  const subbedTopics = serverEventsMgr.subscribe(topics, client_id);
  res.status(200).json({ message: 'successfully subscribed', topics: subbedTopics });
};

export const testTrigger: RequestHandler = (req, res) => {
  const data: EventData = {
    type: TestEvents.test,
    payload: {
      message: 'This is a test message sent over sse',
    },
    timestamp: new Date(),
  };

  serverEventsMgr.broadcast(Topics.test, data);

  res.status(200).json({
    message: 'event triggered',
  });
};
