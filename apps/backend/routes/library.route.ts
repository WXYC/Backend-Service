import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as libraryController from '../controllers/library.controller.js';
import * as requestLineController from '../controllers/requestLine.controller.js';
import { trackActivity } from '../middleware/trackActivity.js';
import { conditionalGet } from '../middleware/conditionalGet.js';
import { getCatalogLastModifiedAt } from '../services/library.service.js';

export const library_route = Router();

// Public library search endpoint (for request line feature)
// Requires JWT auth but no specific role/permissions
library_route.get('/search', requirePermissions({}), trackActivity, requestLineController.searchLibraryEndpoint);

library_route.get('/', requirePermissions({ catalog: ['read'] }), libraryController.searchForAlbum);

library_route.get('/query', requirePermissions({ catalog: ['read'] }), libraryController.searchLibraryQueryEndpoint);

// Catalog bulk export (BS#1468 / Epic F, parent #1466). `conditionalGet` gates
// `304` on the library_watermark so a client that has cloned the catalog
// re-pulls only when it changes (~daily). Same `catalog:read` auth as the other
// catalog reads.
library_route.get(
  '/catalog',
  requirePermissions({ catalog: ['read'] }),
  conditionalGet(getCatalogLastModifiedAt),
  libraryController.exportCatalog
);

// BMI played-works export (BS#1500 — tubafrenzy `recentBMI` successor). Gated
// to MD/SM via `catalog:['write']` (DJs/members lack it), which is exactly the
// librarian/MD submission audience with no new permission minted. Keyed on a
// real `?from=&to=` date range. Output *format* + artist-proxy default are
// finalized in #1507; the range/filter/coverage contract lands here.
library_route.get(
  '/bmi-performance-list',
  requirePermissions({ catalog: ['write'] }),
  libraryController.exportBmiPerformanceList
);

library_route.post('/', requirePermissions({ catalog: ['write'] }), libraryController.addAlbum);

library_route.get('/rotation', requirePermissions({ catalog: ['read'] }), libraryController.getRotation);

library_route.post('/rotation', requirePermissions({ catalog: ['write'] }), libraryController.addRotation);

library_route.patch('/rotation', requirePermissions({ catalog: ['write'] }), libraryController.killRotation);

library_route.get(
  '/rotation/:rotation_id/tracks',
  requirePermissions({ catalog: ['read'] }),
  libraryController.getRotationTracks
);

library_route.post('/artists', requirePermissions({ catalog: ['write'] }), libraryController.addArtist);

library_route.get(
  '/artists/search',
  requirePermissions({ catalog: ['write'] }),
  libraryController.searchArtistsInGenre
);

library_route.get('/artists/peek-code', requirePermissions({ catalog: ['write'] }), libraryController.peekArtistNumber);

library_route.get('/formats', requirePermissions({ catalog: ['read'] }), libraryController.getFormats);

library_route.post('/formats', requirePermissions({ catalog: ['write'] }), libraryController.addFormat);

library_route.get('/genres', requirePermissions({ catalog: ['read'] }), libraryController.getGenres);

library_route.post('/genres', requirePermissions({ catalog: ['write'] }), libraryController.addGenre);

library_route.get('/info', requirePermissions({ catalog: ['read'] }), libraryController.getAlbum);

library_route.patch('/:id', requirePermissions({ catalog: ['write'] }), libraryController.updateAlbum);

// Missing/found stack-marking (BS#393): gated to catalog:read rather than
// catalog:write so DJs (who only hold catalog:read per shared/authentication/
// src/auth.roles.ts) can flag a stack missing/found while pulling records.
// This is a status toggle on an existing row, not a catalog write (add/edit/
// delete), so it doesn't need the musicDirector-and-above bar the other PATCH
// /:id (updateAlbum) and POST routes on this router keep.
library_route.patch('/:id/missing', requirePermissions({ catalog: ['read'] }), libraryController.markMissing);

library_route.patch('/:id/found', requirePermissions({ catalog: ['read'] }), libraryController.markFound);
