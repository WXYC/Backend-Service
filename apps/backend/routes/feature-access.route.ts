import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as featureAccessController from '../controllers/feature-access.controller.js';

export const feature_access_route = Router();

// GET /feature-access - any verified token (anonymous sessions included, who see false everywhere)
feature_access_route.get('/', requirePermissions({}), featureAccessController.getFeatureAccess);
