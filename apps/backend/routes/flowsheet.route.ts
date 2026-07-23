import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as flowsheetController from '../controllers/flowsheet.controller';
import * as searchController from '../controllers/search.controller';
import * as suggestController from '../controllers/suggest.controller';
import * as flowsheet_service from '../services/flowsheet.service';
import { flowsheetMirror } from '../middleware/legacy/flowsheet.mirror';
import { conditionalGet, singleValidatorCache } from '../middleware/conditionalGet';
import { showMemberMiddleware } from '../middleware/checkShowMember';

export const flowsheet_route = Router();

// Conditional-GET over the flowsheet watermark (BS#902); the catalog passes a
// different provider (BS#1467) but reuses the same middleware factory.
// `singleValidatorCache` (BS#1689) makes the watermark `Last-Modified` this
// sets the SINGLE freshness validator on these routes — it suppresses
// Express's own default per-body `ETag` and marks `Cache-Control: no-cache`,
// so a client can't trip an independent, un-watermarked 304 off a stale
// cached ETag. Order matters: it must run before the route handler emits a
// body, so it's chained ahead of the mirror/controller handlers below rather
// than folded into the conditionalGet factory (which the catalog route also
// uses, out of this fix's scope).
const flowsheetConditionalGet = [conditionalGet(flowsheet_service.getLastModifiedAt), singleValidatorCache];

// Public playlist archive search
flowsheet_route.get('/search', searchController.searchFlowsheetEndpoint);

flowsheet_route.get('/', flowsheetConditionalGet, flowsheetMirror.getEntries, flowsheetController.getEntries);

flowsheet_route.post(
  '/',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetMirror.addEntry,
  flowsheetController.addEntry
);

flowsheet_route.patch(
  '/',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetMirror.updateEntry,
  flowsheetController.updateEntry
);

flowsheet_route.delete(
  '/',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetMirror.deleteEntry,
  flowsheetController.deleteEntry
);

flowsheet_route.patch(
  '/play-order',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  /*flowsheetMirror.changeOrder,*/
  flowsheetController.changeOrder
);

flowsheet_route.get('/latest', flowsheetConditionalGet, flowsheetController.getLatest);

flowsheet_route.post(
  '/join',
  requirePermissions({ flowsheet: ['write'] }),
  flowsheetMirror.startShow,
  flowsheetController.joinShow
);

flowsheet_route.post(
  '/end',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetMirror.endShow,
  flowsheetController.leaveShow
);

flowsheet_route.get('/djs-on-air', flowsheetController.getDJList);

flowsheet_route.get('/on-air', flowsheetController.getOnAir);

flowsheet_route.get('/playlist', flowsheetController.getShowInfo);

flowsheet_route.get('/show-info', flowsheetController.getShowInfo);

// Ghost text autocomplete suggestions
flowsheet_route.get(
  '/suggest/artists',
  requirePermissions({ flowsheet: ['read'] }),
  suggestController.suggestArtistsEndpoint
);
flowsheet_route.get(
  '/suggest/tracks',
  requirePermissions({ flowsheet: ['read'] }),
  suggestController.suggestTracksEndpoint
);
flowsheet_route.get(
  '/suggest/track-details',
  requirePermissions({ flowsheet: ['read'] }),
  suggestController.getTrackDetailsEndpoint
);
