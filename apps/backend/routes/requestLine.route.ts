import { Router } from 'express';
import * as requestLineController from '../controllers/requestLine.controller.js';
import { requireAnonymousAuth } from '../middleware/anonymousAuth.js';

export const request_line_route = Router();

// Device registration - get token for anonymous requests
request_line_route.post('/register', requestLineController.registerDevice);

// Request Line - song requests from listeners (requires anonymous auth)
request_line_route.post('/', requireAnonymousAuth, requestLineController.submitRequestLine);
