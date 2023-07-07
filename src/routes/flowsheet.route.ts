import { Router } from 'express';
import * as flowsheetController from '../controllers/flowsheet.controller';

export const flowsheet_route = Router();

flowsheet_route.get('/', flowsheetController.get);

flowsheet_route.get('/latest', flowsheetController.latest);
