import { Router } from 'express';
import * as serverEvents from '../controllers/events.conroller.js';
import { cognitoMiddleware } from '../middleware/cognito.auth.js';

export const events_route = Router();

//TODO: secure - mgmt & individual dj
events_route.post('/register', serverEvents.registerEventClient);

events_route.put('/subscribe', serverEvents.subscribeToTopic);

events_route.get('/test', serverEvents.testTrigger);
