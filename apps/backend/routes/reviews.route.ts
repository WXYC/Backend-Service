import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as reviewsController from '../controllers/reviews.controller.js';

export const reviews_route = Router();

// `reviews: write` is the gate; who may edit WHICH review is the service's call (reviews.service.ts
// `editOutcome`), since it turns on authorship and the item's print state. Pinned by
// tests/unit/routes/reviews-permissions.route.test.ts — the integration tier runs AUTH_BYPASS=true
// and cannot see these gates.
reviews_route.post('/', requirePermissions({ reviews: ['write'] }), reviewsController.createReview);
reviews_route.patch('/:id', requirePermissions({ reviews: ['write'] }), reviewsController.patchReview);
