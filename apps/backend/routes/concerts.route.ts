import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as concertsController from '../controllers/concerts.controller.js';

export const concerts_route = Router();

// Anonymous session auth (any valid JWT, no permission scope) — matches the
// /proxy iOS read surfaces. See BS#1603.
concerts_route.use(requirePermissions({}));

concerts_route.get('/', concertsController.getConcerts);
