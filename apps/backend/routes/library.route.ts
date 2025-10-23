import { Router } from 'express';
import * as libraryController from '../controllers/library.controller.js';
import { cognitoMiddleware, Roles } from '../middleware/cognito.auth.js';

const { dj, musicDirector, stationMgr } = Roles;

export const library_route = Router();

library_route.get('/', cognitoMiddleware(dj), libraryController.searchForAlbum);

library_route.post('/', cognitoMiddleware(musicDirector, stationMgr), libraryController.addAlbum);

library_route.get('/rotation', cognitoMiddleware(dj), libraryController.getRotation);

library_route.post('/rotation', cognitoMiddleware(musicDirector, stationMgr), libraryController.addRotation);

library_route.patch('/rotation', cognitoMiddleware(musicDirector, stationMgr), libraryController.killRotation);

library_route.post('/artists', cognitoMiddleware(musicDirector, stationMgr), libraryController.addArtist);

library_route.get('/formats', cognitoMiddleware(dj), libraryController.getFormats);

library_route.post('/formats', cognitoMiddleware(musicDirector, stationMgr), libraryController.addFormat);

library_route.get('/genres', cognitoMiddleware(dj), libraryController.getGenres);

library_route.post('/genres', cognitoMiddleware(musicDirector, stationMgr), libraryController.addGenre);

library_route.get('/info', cognitoMiddleware(dj), libraryController.getAlbum);
