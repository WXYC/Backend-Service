import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as libraryController from '../controllers/library.controller.js';
import * as requestLineController from '../controllers/requestLine.controller.js';
import { trackActivity } from '../middleware/trackActivity.js';
import { conditionalGet } from '../middleware/conditionalGet.js';
import { getCatalogLastModifiedAt } from '../services/library.service.js';

export const library_route = Router();

// -----------------------------------------------------------------------
// Three library-search variants (BS#980)
// -----------------------------------------------------------------------
//
// This router mounts three GET endpoints that all search the catalog but
// serve different callers with different auth, query shapes, and response
// shapes. Read the docstring on each handler before adding a fourth or
// changing one of these three:
//
//   - `GET /search` -> `requestLineController.searchLibraryEndpoint`. Public
//     (any JWT, no `catalog:*` permission) — backs the request-line flow.
//     Free-text `query` and/or `artist`/`title`; returns a `{ success,
//     results, total, query }` envelope.
//   - `GET /` -> `libraryController.searchForAlbum`. `catalog:read` —
//     backs dj-site's "classic" experience catalog search (plus the
//     streaming-only "Browse Exclusive Albums" view). `artist_name` /
//     `album_title` / `on_streaming`; returns a bare result array.
//   - `GET /query` -> `libraryController.searchLibraryQueryEndpoint`.
//     `catalog:read` — backs dj-site's "modern" experience query-builder
//     panel (Catalog Track Search project, WXYC/projects/30), client-gated
//     there by `NEXT_PUBLIC_CATALOG_TRACK_SEARCH_UI_ENABLED`. Field-scoped
//     `q` syntax (`artist:`, `album:`, `label:`) plus sort/filter/offset
//     pagination; returns a `{ results, total, page, totalPages }` page.
//
// All three ultimately share the same tsvector + trigram + CTA/LML fallback
// cascade for plain-text queries (`searchLibraryBothMode` /
// `library-search.service.ts`'s cascade gate) — they differ in how a caller
// reaches that cascade and how the result is shaped on the wire, not in the
// underlying catalog data. As of this writing all three are live production
// surfaces for distinct callers; none is a deprecated shim.

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

// CTA sibling of the catalog export (BS#1965): compilation_track_artist rows for
// the Backend-sourced library.db producer (discogs-etl#351). Same `catalog:read`
// auth, same `library_watermark` conditional-GET.
//
// REGISTRATION ORDER IS LOAD-BEARING — keep this next to the '/catalog' literal
// above, ahead of the '/:id' routes. The competing route is not '/catalog' (two
// distinct literals never shadow each other, in any order); it is the TEMPLATED
// GET '/:id/compilation-tracks' further down, which matches this same URL with
// id === 'catalog'. Registered after it, Express hands this request to that
// handler, `Number('catalog')` is NaN, and the producer gets a 4xx/5xx — with no
// auth-layer signal to distinguish it, since both routes carry the identical
// catalog:['read'] permission. The integration spec's 200 from this path is what
// proves the ordering holds.
library_route.get(
  '/catalog/compilation-tracks',
  requirePermissions({ catalog: ['read'] }),
  conditionalGet(getCatalogLastModifiedAt),
  libraryController.exportCompilationTracks
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

// The two legacy cross-reference listings — successors to `/wxycdb`'s
// `xrefsToLibraryCodes.jsp` and `xrefsToLibraryReleases.jsp`. Read-only: both
// sets are frozen (artist codes) or dropped (releases) by WXYC/wiki#89's
// decision D5, so no write sibling belongs on this router.
//
// `catalog: ['write']` on a READ, deliberately, and for the same reason
// `/bmi-performance-list` above carries it: `mainmenu.jsp:32-38` wraps both of
// these links in `<c:if test="${user.hasAdminAccess()}">`, unlike Missing
// Releases and the rotation links right below them, which sit outside it. That
// flag is tubafrenzy's librarian/MD tier, and `catalog: ['write']` is the
// grant that selects musicDirector + stationManager here — the same pair —
// without minting a statement key. `catalog: ['read']` would hand every DJ and
// `member` a screen the legacy system gated; a new `catalog: ['admin']`-style
// key would have to be decided for all four roles (auth.roles.ts) to express a
// tier that already exists. `/artists/search` and `/artists/peek-code` set the
// same precedent for an admin-gated read.
//
// Two honest caveats on that argument. First, `hasAdminAccess()` does NOT
// partition tubafrenzy's admin menu the way "everything in that block is
// MD-gated here" implies. The `<c:if>` holds FOUR links, and the two that are
// not these already have BS read successors at `catalog: ['read']`: "Add, Edit,
// & Delete Artists & Releases" → `GET /library/artists/:id`,
// `/artists/:id/releases`, `/artists/by-code`; "Manage Labels" → `GET /labels`,
// `/labels/info`, `/labels/search` (only the label POST is at `write`). So the
// inference from that block supports two of its four links, and for the other
// two this repo has already decided the opposite way.
// Second, `auth.roles.ts` says three separate times that borrowing a permission
// key because it "happens to select the right roles today" is the thing not to
// do, and that is exactly the move here. The tier stays anyway: the shipped
// dj-site consumer independently gates these screens on
// `requireRole(session, Authorization.MD)`, the two existing `catalog: ['write']`
// reads set the precedent, and of the two alternatives one widens access the
// legacy system withheld while the other mints a four-role statement key to name
// a tier that already exists. If a third admin-gated read arrives, that is the
// signal to mint the key rather than to borrow again.
//
// Two literal segments, so neither collides with the templated
// `/:id/compilation-tracks` GET further down (different second segment) — but
// they are registered here, ahead of every templated route on this router,
// rather than relying on that.
library_route.get(
  '/crossreferences/artists',
  requirePermissions({ catalog: ['write'] }),
  libraryController.listArtistCrossReferences
);

library_route.get(
  '/crossreferences/releases',
  requirePermissions({ catalog: ['write'] }),
  libraryController.listReleaseCrossReferences
);

library_route.post('/', requirePermissions({ catalog: ['write'] }), libraryController.addAlbum);

library_route.get('/rotation', requirePermissions({ catalog: ['read'] }), libraryController.getRotation);

// BS#2109: the cataloging-backlog queue. REGISTRATION ORDER IS LOAD-BEARING —
// keep this literal ahead of the templated `/rotation/:id` routes below (the
// same '/catalog' vs '/:id/compilation-tracks' trap documented above).
//
// Both of those templated routes now exist: WXYC/Backend-Service#2113's
// `PATCH /rotation/:id` and WXYC/Backend-Service#2410's `GET /rotation/:id`.
// The GET is the one that can actually shadow this line. Express falls
// through a Layer whose Route does not handle the request method, so the
// PATCH never could — but the #2410 GET matches this path's method AND its
// segment count, which makes it the router's first genuine same-method
// hazard. Pinned by `tests/unit/routes/library-rotation-uncatalogued.route.test.ts`
// (which now fails if the parameterized GET goes missing as well as if it is
// registered ahead of this line) and by
// `tests/unit/routes/library-rotation-route-order.route.test.ts`.
library_route.get(
  '/rotation/uncatalogued',
  requirePermissions({ catalog: ['read'] }),
  libraryController.getUncataloguedRotation
);

library_route.post('/rotation', requirePermissions({ catalog: ['write'] }), libraryController.addRotation);

library_route.patch('/rotation', requirePermissions({ catalog: ['write'] }), libraryController.killRotation);

library_route.get(
  '/rotation/:rotation_id/tracks',
  requirePermissions({ catalog: ['read'] }),
  libraryController.getRotationTracks
);

// BS#2109: links an uncatalogued rotation row to a library release (the
// "Import to Library" step). Two-segment route, so it does not collide with
// `/rotation/uncatalogued` (one segment) or with `/rotation/:id`.
library_route.patch(
  '/rotation/:rotation_id/link',
  requirePermissions({ catalog: ['write'] }),
  libraryController.linkRotationToAlbum
);

// BS#2410: the single-row rotation read, for dj-site#1161's Import to Library
// screen and its pre-submit staleness check. `catalog: ['read']`, matching
// `GET /rotation` and `GET /rotation/uncatalogued` rather than the PATCH that
// shares its path.
//
// Registered after every literal `/rotation/*` route above, and this is the
// registration on this router for which that ordering is load-bearing rather
// than defensive: it is the first parameterized route sharing both method and
// segment count with a literal (`GET /rotation/uncatalogued`), so ahead of
// that line it would capture the literal segment as an id.
library_route.get('/rotation/:id', requirePermissions({ catalog: ['read'] }), libraryController.getRotationRow);

// BS#2113: field-level rotation edit. Registered after every literal
// `/rotation/*` route above so `:id` never shadows a more specific path —
// belt-and-braces for this one, since no literal `PATCH /rotation/<name>`
// exists to be shadowed today.
library_route.patch('/rotation/:id', requirePermissions({ catalog: ['write'] }), libraryController.updateRotation);

library_route.post('/artists', requirePermissions({ catalog: ['write'] }), libraryController.addArtist);

library_route.get(
  '/artists/search',
  requirePermissions({ catalog: ['write'] }),
  libraryController.searchArtistsInGenre
);

library_route.get('/artists/peek-code', requirePermissions({ catalog: ['write'] }), libraryController.peekArtistNumber);

// BS#2149: resolves a fully-specified code (genre_id + code_letters +
// code_number) to the artists that own it -- the /wxycdb "find" half of the JSP
// code-lookup flow that `peek-code` (a "next free number" create helper)
// cannot answer. Answers a list because the code triple is not unique; see
// `getArtistsByCode`.
//
// `catalog: ['read']`, NOT `catalog: ['write']` like the two create-flow
// helpers above (BS#2149 review finding 3). Shelf-code data is already
// DJ-readable on two live endpoints: `GET /library/query` returns
// `code_letters`/`code_number`/`code_artist_number` at `catalog: ['read']`
// (`library-search.service.ts`), and `GET /djs/bin` returns the same at
// `bin: ['read']` (`djs.service.ts`). A DJ needs the call number to pull a
// record, and this route returns strictly LESS than `/library/query` already
// does, so widening it leaks nothing. (An earlier version of this comment
// argued the opposite -- that widening the tier for one of three siblings
// would be an inconsistency. That's now falsified the other way: sibling PR
// #2162 lands `catalog: ['read']` on `GET /artists/:id` and
// `GET /artists/:id/releases`, so `write` here would be the inconsistency.)
// `search` and `peek-code` stay at `catalog: ['write']` -- they back the
// create-artist flow, not a plain lookup.
//
// Registered in this same `/artists/*` block, ahead of where
// WXYC/Backend-Service#2156 adds a parameterized `/artists/:id` route, so
// Express's path matching can't swallow it -- keep it here if that route is
// ever reordered.
library_route.get('/artists/by-code', requirePermissions({ catalog: ['read'] }), libraryController.resolveArtistByCode);

// BS#2156 artist-card routes. REGISTRATION ORDER IS LOAD-BEARING: these are
// the first parameterized `/artists/:id`-style routes on this router, and
// must be registered AFTER every literal `/artists/*` route above (`search`,
// `peek-code`, and WXYC/Backend-Service#2149's future `by-code`) or Express
// hands e.g. `GET /artists/search` to this `:id` handler instead, with
// `Number('search')` becoming NaN -- the same `/catalog` vs
// `/:id/compilation-tracks` trap documented above. `/artists/search` and
// `/artists/peek-code` staying on their own handlers is pinned by the
// integration spec.
library_route.get('/artists/:id', requirePermissions({ catalog: ['read'] }), libraryController.getArtistCard);

library_route.patch('/artists/:id', requirePermissions({ catalog: ['write'] }), libraryController.updateArtistCard);

library_route.get(
  '/artists/:id/releases',
  requirePermissions({ catalog: ['read'] }),
  libraryController.getArtistReleases
);

library_route.get('/formats', requirePermissions({ catalog: ['read'] }), libraryController.getFormats);

library_route.post('/formats', requirePermissions({ catalog: ['write'] }), libraryController.addFormat);

// BS#1682: genre names are non-sensitive station-wide reference data (same
// tier as /playlists and /concerts), and dj-site#1004's argument-pure SSR
// seed cannot attach a JWT. Public GET; POST stays catalog:write-gated below.
library_route.get('/genres', libraryController.getGenres);

library_route.post('/genres', requirePermissions({ catalog: ['write'] }), libraryController.addGenre);

library_route.get('/info', requirePermissions({ catalog: ['read'] }), libraryController.getAlbum);

library_route.patch('/:id', requirePermissions({ catalog: ['write'] }), libraryController.updateAlbum);

// BS#2112: hard delete, gated to catalog:write (same bar as updateAlbum/
// addAlbum) — irreversible, so it does not get the lighter catalog:read bar
// missing/found use below.
library_route.delete('/:id', requirePermissions({ catalog: ['write'] }), libraryController.deleteAlbum);

// Missing/found stack-marking (BS#393): gated to catalog:read rather than
// catalog:write so DJs (who only hold catalog:read per shared/authentication/
// src/auth.roles.ts) can flag a stack missing/found while pulling records.
// This is a status toggle on an existing row, not a catalog write (add/edit/
// delete), so it doesn't need the musicDirector-and-above bar the other PATCH
// /:id (updateAlbum) and POST routes on this router keep.
library_route.patch('/:id/missing', requirePermissions({ catalog: ['read'] }), libraryController.markMissing);

library_route.patch('/:id/found', requirePermissions({ catalog: ['read'] }), libraryController.markFound);

// BS#1283 (epic #1280 sub-issue 3): manual counterpart to the daily
// library-discogs-unavailable-recheck cron. Gated to catalog:write (same bar
// as updateAlbum/addAlbum) since it can rewrite rotation.discogs_release_id.
library_route.post(
  '/:id/discogs-recheck',
  requirePermissions({ catalog: ['write'] }),
  libraryController.manualDiscogsRecheck
);

// Compilation-track (CTA) write path — BS#1964 / Phase 3.5 `/wxycdb` cutover
// (contract: wxyc-shared api.yaml v1.28.0, WXYC/wxyc-shared#291). Makes V/A
// per-track artists writable so compilation track search survives the
// tubafrenzy turndown. `{id}` is the serial `library.id` (like the sibling
// `/:id` PATCH/missing/found routes). GET list is `catalog:read` (any DJ);
// the additive POST and the Discogs-suggestions read are `catalog:write` (the
// MD/SM librarian bar, matching addAlbum/updateAlbum). The two-segment
// suggestions GET is registered before the one-segment list GET so it can't be
// shadowed.
library_route.get(
  '/:id/compilation-tracks/discogs-suggestions',
  requirePermissions({ catalog: ['write'] }),
  libraryController.getCompilationTrackDiscogsSuggestions
);

library_route.get(
  '/:id/compilation-tracks',
  requirePermissions({ catalog: ['read'] }),
  libraryController.getCompilationTracks
);

library_route.post(
  '/:id/compilation-tracks',
  requirePermissions({ catalog: ['write'] }),
  libraryController.writeCompilationTracks
);
