import { Router } from 'express';
import { cognitoMiddleware, Roles } from '../middleware/cognito.auth.js';
import * as flowsheetController from '../controllers/flowsheet.controller.js';

const { dj } = Roles;

export const flowsheet_route = Router();

flowsheet_route.get('/', flowsheetController.getEntries);

flowsheet_route.post('/', cognitoMiddleware(dj), flowsheetController.addEntry);

flowsheet_route.patch('/', cognitoMiddleware(dj), flowsheetController.updateEntry);

flowsheet_route.delete('/', cognitoMiddleware(dj), flowsheetController.deleteEntry);

flowsheet_route.patch('/play-order', cognitoMiddleware(dj), flowsheetController.changeOrder);

flowsheet_route.get('/latest', flowsheetController.getLatest);

flowsheet_route.post('/join', cognitoMiddleware(dj), flowsheetController.joinShow);

flowsheet_route.post('/end', cognitoMiddleware(dj), flowsheetController.leaveShow);

flowsheet_route.get('/djs-on-air', flowsheetController.getDJList);

flowsheet_route.get('/on-air', flowsheetController.getOnAir);

flowsheet_route.get('/playlist', flowsheetController.getShowInfo);

flowsheet_route.get('/show-info', flowsheetController.getShowInfo);
