import { Router } from 'express';
import * as flowsheetController from '../controllers/flowsheet.controller';

export const flowsheet_route = Router();

flowsheet_route.get('/recentEntries', flowsheetController.get);

flowsheet_route.get('/latest', flowsheetController.getLatest);

flowsheet_route.post('/', flowsheetController.add_entry);

flowsheet_route.post('/join', flowsheetController.join_show);
