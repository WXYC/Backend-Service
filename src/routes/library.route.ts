import { Router } from 'express';
import * as libraryController from '../controllers/library.controller';

export const library_route = Router();

//secure: discuss, should we lock down the catalog?
library_route.get('/', libraryController.get);

//
//secure: mgmt
library_route.post('/', libraryController.post);

library_route.get('/get-rotation', libraryController.getRotation);

//secure: mgmt
library_route.post('/add-artist', libraryController.addArtist);

//secure: djs
library_route.post('/bin-add', libraryController.addToBin);

//secure: djs
library_route.delete('/bin-remove', libraryController.removeFromBin);
