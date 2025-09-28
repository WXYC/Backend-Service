import { Router } from 'express';
import * as djsController from '../controllers/djs.controller.js';
import { cognitoMiddleware, Roles } from '../middleware/cognito.auth.js';

const { dj, mgmt } = Roles;

export const dj_route = Router();

//TODO: secure - mgmt & individual dj
dj_route.get('/', cognitoMiddleware(dj), djsController.getDJInfo);

dj_route.delete('/', cognitoMiddleware(mgmt), djsController.deleteDJ);

dj_route.post('/register', cognitoMiddleware(mgmt), djsController.register);

dj_route.patch('/register', cognitoMiddleware(dj), djsController.update);

dj_route.post('/bin', cognitoMiddleware(dj), djsController.addToBin);

dj_route.delete('/bin', cognitoMiddleware(dj), djsController.deleteFromBin);

dj_route.get('/bin', cognitoMiddleware(dj), djsController.getBin);

dj_route.get('/playlists', cognitoMiddleware(dj), djsController.getPlaylistsForDJ);
