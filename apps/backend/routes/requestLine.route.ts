import { Router } from 'express';
import * as requestLineController from '../controllers/requestLine.controller.js';
import { requireAnonymousAuth } from '../middleware/anonymousAuth.js';
import { registrationRateLimit, songRequestRateLimit } from '../middleware/rateLimiting.js';

export const request_line_route = Router();

// Device registration - get token for anonymous requests
// Rate limited by IP address
request_line_route.post('/register', registrationRateLimit, requestLineController.registerDevice);

// Request Line - song requests from listeners (requires anonymous auth)
// Rate limited by device ID after authentication
request_line_route.post('/', requireAnonymousAuth, songRequestRateLimit, requestLineController.submitRequestLine);

// Parse only - for debugging AI parser (requires anonymous auth)
request_line_route.post('/parse', requireAnonymousAuth, requestLineController.parseMessage);
