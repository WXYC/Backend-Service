import { Router } from 'express';
import * as requestController from '../controllers/requests.controller.js';
import { Roles } from '../middleware/cognito.auth.js';

export const requests_route = Router();

// TODO: add song request request token validation
requests_route.post('/', requestController.submitRequest);

// TODO: add route for any client to request a token
// requests_route.post('/token', )
