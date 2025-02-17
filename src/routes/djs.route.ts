import { Router } from 'express';
import * as djsController from '../controllers/djs.controller';
import { cognitoMiddleware } from '../middleware/cognito.auth';

export const dj_route = Router();

//secure: mgmt & individual dj
dj_route.get('/', cognitoMiddleware(), djsController.getDJInfo);

//secure: mgmt
dj_route.post('/register', cognitoMiddleware('station-management'), djsController.register);

dj_route.patch('/register', cognitoMiddleware(), djsController.update);

dj_route.post('/bin', cognitoMiddleware(), djsController.addToBin);

dj_route.delete('/bin', cognitoMiddleware(), djsController.deleteFromBin);

dj_route.get('/bin', cognitoMiddleware(), djsController.getBin);

dj_route.get('/playlists', cognitoMiddleware(), djsController.getPlaylistsForDJ);
