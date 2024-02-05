import { Router } from 'express';
import * as djsController from '../controllers/djs.controller';
import { cognitoMiddleware } from '../middleware/cognito.auth';

export const dj_route = Router();

//secure: mgmt & individual dj
dj_route.get('/', djsController.getDJInfo);

//secure: mgmt
dj_route.post('/register', djsController.register);

dj_route.post('/bin', cognitoMiddleware, djsController.addToBin);

dj_route.delete('/bin', cognitoMiddleware, djsController.deleteFromBin);

dj_route.get('/bin', cognitoMiddleware, djsController.getBin);

dj_route.get('/playlists', cognitoMiddleware, djsController.getPlaylistsForDJ);

dj_route.get('/playlist', cognitoMiddleware, djsController.getPlaylist);
