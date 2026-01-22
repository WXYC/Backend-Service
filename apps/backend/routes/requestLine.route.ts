import { Router } from 'express';
import { requirePermissions } from '@wxyc/authentication';
import * as requestLineController from '../controllers/requestLine.controller.js';

export const request_line_route = Router();

// Request Line - song requests from listeners
request_line_route.post('/', requirePermissions(), requestLineController.submitRequestLine);
