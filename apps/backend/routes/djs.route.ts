import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as djsController from '../controllers/djs.controller.js';

export const dj_route = Router();

dj_route.post('/bin', requirePermissions({ bin: ['write'] }), djsController.addToBin);

dj_route.delete('/bin', requirePermissions({ bin: ['write'] }), djsController.deleteFromBin);

dj_route.get('/bin', requirePermissions({ bin: ['read'] }), djsController.getBin);

dj_route.get('/playlists', requirePermissions({ flowsheet: ['read'] }), djsController.getPlaylistsForDJ);
