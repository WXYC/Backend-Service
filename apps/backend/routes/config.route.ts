import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as configController from '../controllers/config.controller.js';
import { trackActivity } from '../middleware/trackActivity.js';

export const config_route = Router();

// GET /config - unauthenticated bootstrap configuration
config_route.get('/', configController.getConfig);

// GET /config/secrets - authenticated, serves third-party API credentials
config_route.get('/secrets', requirePermissions({}), trackActivity, configController.getSecrets);
