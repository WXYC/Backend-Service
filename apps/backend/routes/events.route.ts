import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as serverEvents from '../controllers/events.conroller.js';

export const events_route = Router();

//TODO: You shouldn't have to be authenticated to register an event client.
// Each topic has it's own permissions, some of which are public.
events_route.post('/register', requirePermissions({ flowsheet: ['read'] }), serverEvents.registerEventClient);

//TODO: You shouldn't have to be authenticated to subscribe to a topic
events_route.put('/subscribe', requirePermissions({ flowsheet: ['read'] }), serverEvents.subscribeToTopic);

events_route.get('/test', serverEvents.testTrigger);
