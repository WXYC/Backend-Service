import { Request, RequestHandler } from 'express';
import { serverEventsMgr, TestEvents, Topics, type EventData } from '../utils/serverEvents';
import WxycError from '../utils/error.js';

// Roles permitted to subscribe to DJ-tier event topics. Matches the WXYCRoles
// hierarchy (member < dj < musicDirector < stationManager) — any role at or
// above the dj tier qualifies. Kept as an explicit array (rather than a
// hierarchy lookup) so the role list lives next to the topic list — a future
// role addition prompts a deliberate edit here (BS#1104).
const DJ_TIER_ROLES = ['dj', 'musicDirector', 'stationManager'];

// Define access levels for events
// Empty array = public access, array with roles = requires one of those roles
const TopicAuthz: Record<string, string[]> = {
  [Topics.test]: [],
  [Topics.liveFs]: [],
  [Topics.showDj]: DJ_TIER_ROLES,
  [Topics.primaryDj]: DJ_TIER_ROLES,
  [Topics.mirror]: DJ_TIER_ROLES,
};

const filterAuthorizedTopics = (req: Pick<Request, 'auth'>, topics: string[]) => {
  return topics.filter((topic) => {
    const allowedRoles = TopicAuthz[topic];
    if (allowedRoles === undefined) return false;
    if (allowedRoles.length === 0) return true; // public topic
    // Per-topic authz check (BS#1104). Pre-fix this returned `!!req.auth` —
    // any authenticated caller, including a member-role user, got every
    // topic in TopicAuthz including the `mirror` SQL stream.
    const role = req.auth?.role;
    return role !== undefined && allowedRoles.includes(role);
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

  // Per-topic authz check (BS#1104). Pre-fix this called subscribe with the
  // raw body topics — a member-role caller could subscribe to `mirror` /
  // `primaryDj` / `showDj` straight from the wire.
  const authorizedTopics = filterAuthorizedTopics(req, topics);
  const subbedTopics = serverEventsMgr.subscribe(authorizedTopics, client_id);
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
