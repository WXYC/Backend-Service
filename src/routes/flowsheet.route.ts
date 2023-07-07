import { Router } from 'express';
import * as flowsheetController from '../contollers/flowsheet.controller';

export const flowsheet_route = Router();

flowsheet_route.get('/', flowsheetController.get);
