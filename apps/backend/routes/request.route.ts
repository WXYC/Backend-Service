import { Router } from 'express';
import { requirePermissions } from '@wxyc/authentication';
import * as requestController from '../controllers/request.controller.js';

export const request_route = Router();

// Song requests - requires authenticated user
request_route.post('/', requirePermissions(), requestController.submitRequest);
