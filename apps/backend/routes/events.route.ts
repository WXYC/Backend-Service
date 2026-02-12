import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as serverEvents from '../controllers/events.conroller.js';

export const events_route = Router();

//TODO: secure - mgmt & individual dj
events_route.post('/register', requirePermissions({ flowsheet: ['read'] }), serverEvents.registerEventClient);

events_route.put('/subscribe', requirePermissions({ flowsheet: ['read'] }), serverEvents.subscribeToTopic);

events_route.get('/test', requirePermissions({ flowsheet: ['read'] }), serverEvents.testTrigger);
