import { Router } from 'express';
import * as flowsheetController from '../controllers/flowsheet.controller';

export const flowsheet_route = Router();

flowsheet_route.get('/', flowsheetController.getEntries);

flowsheet_route.post('/', flowsheetController.addEntry);

flowsheet_route.patch('/', flowsheetController.updateEntry);

flowsheet_route.delete('/', flowsheetController.deleteEntry);

flowsheet_route.get('/latest', flowsheetController.getLatest);

flowsheet_route.post('/join', flowsheetController.joinShow);

flowsheet_route.post('/end', flowsheetController.endShow);

flowsheet_route.get('/on-air', flowsheetController.getOnAir);

//flowsheet_route.patch('/play-order', flowsheetController.changeOrder);
