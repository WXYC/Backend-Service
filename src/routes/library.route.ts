import { Router } from 'express';
import * as libraryController from '../controllers/library.controller';
import { cognitoMiddleware } from '../middleware/cognito.auth';

export const library_route = Router();

library_route.get('/', cognitoMiddleware(), libraryController.searchForAlbum);

library_route.post('/', cognitoMiddleware('station-management'), libraryController.addAlbum);

library_route.get('/rotation', cognitoMiddleware(), libraryController.getRotation);

library_route.post('/rotation', cognitoMiddleware('station-management'), libraryController.addRotation);

library_route.patch('/rotation', cognitoMiddleware('station-management'), libraryController.killRotation);

library_route.post('/artists', cognitoMiddleware('station-management'), libraryController.addArtist);

library_route.get('/formats', cognitoMiddleware(), libraryController.getFormats);

library_route.post('/formats', cognitoMiddleware('station-management'), libraryController.addFormat);

library_route.get('/genres', cognitoMiddleware(), libraryController.getGenres);

library_route.post('/genres', cognitoMiddleware('station-management'), libraryController.addGenre);

library_route.get('/info', cognitoMiddleware(), libraryController.getAlbum);
