import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as albumReviewsController from '../controllers/album-reviews.controller.js';

export const album_reviews_route = Router();

// Anonymous session auth (any valid JWT, no permission scope) — matches the
// /concerts and /proxy iOS read surfaces. See ADR 0011 / the
// album-reviews-sheet-sync plan.
album_reviews_route.use(requirePermissions({}));

album_reviews_route.get('/', albumReviewsController.getAlbumReviews);
