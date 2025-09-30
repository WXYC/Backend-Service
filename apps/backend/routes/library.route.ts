import { Router } from 'express';
import * as libraryController from '../controllers/library.controller.js';
import { authMiddleware, requireDJ } from '@wxyc/auth-middleware';

// Role-based access will be handled by Better Auth middleware

export const library_route = Router();

library_route.get('/', authMiddleware(),
  requireDJ, libraryController.searchForAlbum);

library_route.post('/', authMiddleware(),
  requireDJ, libraryController.addAlbum);

library_route.get('/rotation', authMiddleware(),
  requireDJ, libraryController.getRotation);

library_route.post('/rotation', authMiddleware(),
  requireDJ, libraryController.addRotation);

library_route.patch('/rotation', authMiddleware(),
  requireDJ, libraryController.killRotation);

library_route.post('/artists', authMiddleware(),
  requireDJ, libraryController.addArtist);

library_route.get('/formats', authMiddleware(),
  requireDJ, libraryController.getFormats);

library_route.post('/formats', authMiddleware(),
  requireDJ, libraryController.addFormat);

library_route.get('/genres', authMiddleware(),
  requireDJ, libraryController.getGenres);

library_route.post('/genres', authMiddleware(),
  requireDJ, libraryController.addGenre);

library_route.get('/info', authMiddleware(),
  requireDJ, libraryController.getAlbum);
