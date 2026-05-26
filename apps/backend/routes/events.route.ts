import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as serverEvents from '../controllers/events.controller.js';

export const events_route = Router();

//TODO: You shouldn't have to be authenticated to register an event client.
// Each topic has it's own permissions, some of which are public.
events_route.post('/register', requirePermissions({ flowsheet: ['read'] }), serverEvents.registerEventClient);

//TODO: You shouldn't have to be authenticated to subscribe to a topic
events_route.put('/subscribe', requirePermissions({ flowsheet: ['read'] }), serverEvents.subscribeToTopic);

// EventSource-friendly GET counterpart to POST /events/register. No
// route-level auth guard: native browser EventSource can't send an
// Authorization header, and authorization is already per-topic via
// TopicAuthz inside filterAuthorizedTopics — public topics (liveFs,
// test) accept anonymous callers; DJ-tier topics filter out without a
// role match. See docs/live-updates-sse.md.
events_route.get('/stream', serverEvents.streamEventClient);

events_route.get('/test', serverEvents.testTrigger);
