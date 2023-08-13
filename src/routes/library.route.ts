import { Router } from 'express';
import * as libraryController from '../controllers/library.controller';

export const library_route = Router();

//secure: discuss, should we lock down the catalog?
library_route.get('/', libraryController.searchForAlbum);

//secure: mgmt
library_route.post('/', libraryController.addAlbum);

library_route.get('/rotation', libraryController.getRotation);

library_route.post('/rotation', libraryController.addRotation);

//secure: mgmt
library_route.post('/artists', libraryController.addArtist);

library_route.get('/formats', libraryController.getFormats);

library_route.get('/info', libraryController.getAlbum);
