import { Router } from 'express';
import * as libraryController from '../controllers/library.controller';

export const library_route = Router();

//secure: discuss, should we lock down the catalog?
library_route.get('/', libraryController.getAlbum);

//secure: mgmt
library_route.post('/', libraryController.addAlbum);

library_route.get('/get-rotation', libraryController.getRotation);

//secure: mgmt
library_route.post('/add-artist', libraryController.addArtist);

library_route.get('/formats', libraryController.getFormats);
