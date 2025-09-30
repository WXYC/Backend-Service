import { Router } from 'express';
import * as djsController from '../controllers/djs.controller.js';
import { authMiddleware, requireDJ } from '@wxyc/auth-middleware';

// Role-based access will be handled by Better Auth middleware

export const dj_route = Router();

//TODO: secure - mgmt & individual dj
dj_route.get('/', authMiddleware(),
  requireDJ, djsController.getDJInfo);

dj_route.post('/register', authMiddleware(),
  requireDJ, djsController.register);

dj_route.patch('/register', authMiddleware(),
  requireDJ, djsController.update);

dj_route.post('/bin', authMiddleware(),
  requireDJ, djsController.addToBin);

dj_route.delete('/bin', authMiddleware(),
  requireDJ, djsController.deleteFromBin);

dj_route.get('/bin', authMiddleware(),
  requireDJ, djsController.getBin);

dj_route.get('/playlists', authMiddleware(),
  requireDJ, djsController.getPlaylistsForDJ);
