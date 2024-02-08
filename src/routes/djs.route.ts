import { Router } from 'express';
import * as djsController from '../controllers/djs.controller';

export const dj_route = Router();

//secure: mgmt & individual dj
dj_route.get('/', djsController.getDJInfo);

//secure: mgmt
dj_route.post('/register', djsController.register);

dj_route.patch('/register', djsController.update);

dj_route.post('/bin', djsController.addToBin);

dj_route.delete('/bin', djsController.deleteFromBin);

dj_route.get('/bin', djsController.getBin);

dj_route.get('/playlists', djsController.getPlaylistsForDJ);

dj_route.get('/playlist', djsController.getPlaylist);
