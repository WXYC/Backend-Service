import { Router } from 'express';
import * as djsController from '../controllers/djs.controller.js';
import { authMiddleware, requireDJ, requireStationManagement } from '@wxyc/auth-middleware';

// Role-based access will be handled by Better Auth middleware

export const dj_route = Router();

// Get DJ info - DJs can view their own info, station management can view all
dj_route.get('/', authMiddleware(),
  requireDJ, djsController.getDJInfo);

// DJ registration and updates - Station Management only
dj_route.post('/register', authMiddleware(),
  requireStationManagement, djsController.register);

dj_route.patch('/register', authMiddleware(),
  requireStationManagement, djsController.update);

dj_route.post('/bin', authMiddleware(),
  requireDJ, djsController.addToBin);

dj_route.delete('/bin', authMiddleware(),
  requireDJ, djsController.deleteFromBin);

dj_route.get('/bin', authMiddleware(),
  requireDJ, djsController.getBin);

dj_route.get('/playlists', authMiddleware(),
  requireDJ, djsController.getPlaylistsForDJ);
