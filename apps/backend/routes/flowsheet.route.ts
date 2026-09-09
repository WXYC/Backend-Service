import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as flowsheetController from '../controllers/flowsheet.controller';
import * as searchController from '../controllers/search.controller';
import * as suggestController from '../controllers/suggest.controller';
import * as flowsheet_service from '../services/flowsheet.service';
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
// body, so it's chained ahead of the controller handlers below rather
// than folded into the conditionalGet factory (which the catalog route also
// uses, out of this fix's scope).
const flowsheetConditionalGet = [conditionalGet(flowsheet_service.getLastModifiedAt), singleValidatorCache];

// Public playlist archive search
flowsheet_route.get('/search', searchController.searchFlowsheetEndpoint);

// Public date-windowed read (BS#2062) — successor to tubafrenzy's
// /playlists/dailyEntries. Grouped with `/search` above `get('/')` to keep the
// two public reads together; the placement is convention, NOT a shadowing fix.
// `get('/')` matches only the exact path `/flowsheet`, and this router has no
// parameterized route that could swallow `/flowsheet/range`, so moving this
// line below it would change nothing. (Said plainly because the opposite claim
// is easy to assume and would send a future reader hunting a hazard that
// cannot occur.) It carries no `requirePermissions` (the contract is
// `security: []`).
// Deliberately outside `flowsheetConditionalGet`: that middleware's watermark
// is the whole-table `flowsheet_watermark`, which any live write advances, so
// it would invalidate a historical window that cannot have changed — a
// misleading validator rather than a useful one.
flowsheet_route.get('/range', flowsheetController.getEntriesInRange);

flowsheet_route.get('/', flowsheetConditionalGet, flowsheetController.getEntries);

flowsheet_route.post(
  '/',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetController.addEntry
);

flowsheet_route.patch(
  '/',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetController.updateEntry
);

flowsheet_route.delete(
  '/',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetController.deleteEntry
);

flowsheet_route.patch(
  '/play-order',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetController.changeOrder
);

flowsheet_route.get('/latest', flowsheetConditionalGet, flowsheetController.getLatest);

flowsheet_route.post('/join', requirePermissions({ flowsheet: ['write'] }), flowsheetController.joinShow);

flowsheet_route.post(
  '/end',
  requirePermissions({ flowsheet: ['write'] }),
  showMemberMiddleware,
  flowsheetController.leaveShow
);

// Operator close for an abandoned show (BS#2235) — the Backend-Service
// replacement for tubafrenzy's `EndShowServlet` + "Resume a Show", which
// retires with tubafrenzy on 2026-09-07.
//
// `flowsheet: ['manage']` is the only gate in this router above `write`: it
// selects musicDirector and stationManager, excluding the plain `dj` role that
// every other write route here admits. See `shared/authentication/src/auth.roles.ts`.
//
// Placed above `get('/:something')`-shaped routes purely by convention — this
// router declares no parameterized GET that could shadow `/open-shows`.
flowsheet_route.get('/open-shows', requirePermissions({ flowsheet: ['manage'] }), flowsheetController.getOpenShows);

// No `showMemberMiddleware`: the entire point is to act on a show the caller is
// not a member of.
flowsheet_route.post(
  '/shows/:id/force-end',
  requirePermissions({ flowsheet: ['manage'] }),
  flowsheetController.forceEndShow
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
