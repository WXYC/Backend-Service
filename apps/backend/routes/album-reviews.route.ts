import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as albumReviewsController from '../controllers/album-reviews.controller.js';

export const album_reviews_route = Router();

// ROLE-GATED, deliberately NOT the `requirePermissions({})` anonymous tier the
// /concerts and /proxy iOS read surfaces use. This endpoint serves the WHOLE
// form-review archive with no `social_consent` filter — including the rows
// whose reviewer declined social-media publication and the ones written before
// the consent question existed — so the gate is the entire safety argument.
// Anonymous sessions carry no membership, so their JWT has no `role` claim and
// the middleware 403s them. See ADR 0011 and the dj-reviews-internal-surface
// plan; the consent-gated public surface is the `wxycReviews` attach on
// `GET /proxy/metadata/album`.
//
// Pinned by tests/unit/routes/album-reviews-permissions.route.test.ts, which
// wires the real middleware in. The integration suite cannot pin it: it runs
// AUTH_BYPASS=true, which returns next() before any permission check.
album_reviews_route.use(requirePermissions({ album_reviews: ['read'] }));

album_reviews_route.get('/', albumReviewsController.getAlbumReviews);
