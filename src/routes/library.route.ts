import { Router } from 'express';
import * as libraryController from '../controllers/library.controller';

export const library_route = Router();

//secure: mgmt
library_route.post('/', libraryController.post);

//secure: discuss, should we lock down the catalog?
library_route.get('/', libraryController.get);
