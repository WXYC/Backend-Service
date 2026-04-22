import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as requestLineController from '../controllers/requestLine.controller.js';
import { registrationRateLimit, songRequestRateLimit } from '../middleware/rateLimiting.js';
import { trackActivity } from '../middleware/trackActivity.js';

export const request_line_route = Router();

// Device registration - get token for anonymous requests
// Rate limited by IP address
request_line_route.post('/register', registrationRateLimit, requestLineController.registerDevice);

// Request Line - song requests from listeners (requires JWT auth)
// Rate limited by device ID after authentication
request_line_route.post(
  '/',
  requirePermissions({}),
  trackActivity,
  songRequestRateLimit,
  requestLineController.submitRequestLine
);

// Parse only - for debugging AI parser (requires JWT auth)
request_line_route.post('/parse', requirePermissions({}), trackActivity, requestLineController.parseMessage);
