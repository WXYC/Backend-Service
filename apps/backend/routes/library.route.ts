import { Router } from 'express';
import * as libraryController from '../controllers/library.controller.js';
import { authMiddleware, requireDJ, requireMusicDirector, requireStationManagement } from '@wxyc/auth-middleware';

// Role-based access will be handled by Better Auth middleware

export const library_route = Router();

// Search and view operations - DJs and above
library_route.get('/', authMiddleware(),
  requireDJ, libraryController.searchForAlbum);

library_route.get('/info', authMiddleware(),
  requireDJ, libraryController.getAlbum);

library_route.get('/rotation', authMiddleware(),
  requireDJ, libraryController.getRotation);

library_route.get('/formats', authMiddleware(),
  requireDJ, libraryController.getFormats);

library_route.get('/genres', authMiddleware(),
  requireDJ, libraryController.getGenres);

// Add albums and artists - Music Directors and above
library_route.post('/', authMiddleware(),
  requireMusicDirector, libraryController.addAlbum);

library_route.post('/artists', authMiddleware(),
  requireMusicDirector, libraryController.addArtist);

// Manage rotation - Music Directors and above
library_route.post('/rotation', authMiddleware(),
  requireMusicDirector, libraryController.addRotation);

library_route.patch('/rotation', authMiddleware(),
  requireMusicDirector, libraryController.killRotation);

// Manage formats and genres - Station Management only
library_route.post('/formats', authMiddleware(),
  requireStationManagement, libraryController.addFormat);

library_route.post('/genres', authMiddleware(),
  requireStationManagement, libraryController.addGenre);
