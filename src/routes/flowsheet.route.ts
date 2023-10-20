import { Router } from 'express';
import { cognitoMiddleware } from '../middleware/cognito.auth';
import * as flowsheetController from '../controllers/flowsheet.controller';

export const flowsheet_route = Router();

flowsheet_route.get('/', flowsheetController.getEntries);

flowsheet_route.post('/', cognitoMiddleware, flowsheetController.addEntry);

flowsheet_route.patch('/', cognitoMiddleware, flowsheetController.updateEntry);

flowsheet_route.delete('/', cognitoMiddleware, flowsheetController.deleteEntry);

flowsheet_route.get('/latest', flowsheetController.getLatest);

flowsheet_route.post('/join', cognitoMiddleware, flowsheetController.joinShow);

flowsheet_route.post('/end', cognitoMiddleware, flowsheetController.leaveShow);

flowsheet_route.get('/djs-on-air', flowsheetController.getDJList);

flowsheet_route.get('/on-air', flowsheetController.getOnAir);

//flowsheet_route.patch('/play-order', flowsheetController.changeOrder);
