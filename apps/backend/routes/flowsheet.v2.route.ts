import { Router } from 'express';
import * as flowsheetV2Controller from '../controllers/flowsheet.v2.controller.js';

export const flowsheet_v2_route = Router();

// V2 playlist returns entries in discriminated union format
flowsheet_v2_route.get('/playlist', flowsheetV2Controller.getShowInfo);
