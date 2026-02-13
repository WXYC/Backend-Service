import { Router } from 'express';
import * as flowsheetV2Controller from '../controllers/flowsheet.v2.controller.js';

export const flowsheet_v2_route = Router();

// V2 paginated entries in discriminated union format
flowsheet_v2_route.get('/', flowsheetV2Controller.getEntries);

// V2 latest entry in discriminated union format
flowsheet_v2_route.get('/latest', flowsheetV2Controller.getLatest);

// V2 playlist returns entries in discriminated union format
flowsheet_v2_route.get('/playlist', flowsheetV2Controller.getShowInfo);
