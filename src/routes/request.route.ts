import { Router } from 'express';
import * as requestController from '../controllers/request.controller.js';
import { cognitoWithDPoP, Roles } from '../middleware/cognito.auth.js';

const { dj, mgmt } = Roles;

export const request_route = Router();

// Song requests - now requires DPoP validation
request_route.post('/', cognitoWithDPoP(dj), requestController.submitRequest);
