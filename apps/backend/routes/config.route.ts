import { Router } from 'express';
import * as configController from '../controllers/config.controller.js';

export const config_route = Router();

// GET /config - unauthenticated bootstrap configuration
config_route.get('/', configController.getConfig);
