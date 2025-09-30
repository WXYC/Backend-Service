import { Router } from 'express';
import * as serverEvents from '../controllers/events.conroller.js';
import { authMiddleware } from '@wxyc/auth-middleware';

export const events_route = Router();

//TODO: secure - mgmt & individual dj
events_route.post('/register', authMiddleware(), serverEvents.registerEventClient);

events_route.put('/subscribe', authMiddleware(), serverEvents.subscribeToTopic);

events_route.get('/test', serverEvents.testTrigger);