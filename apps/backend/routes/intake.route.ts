import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as intakeController from '../controllers/intake.controller.js';

export const intake_route = Router();

// Grants per the `reviews` key (ADR 0006): reads open at `dj`, the music
// director's logging/edit/delete verbs at `manage`. Pinned by
// tests/unit/routes/intake-permissions.route.test.ts — the integration tier
// runs AUTH_BYPASS=true and cannot see these gates.
intake_route.get('/', requirePermissions({ reviews: ['read'] }), intakeController.listIntake);
intake_route.post('/', requirePermissions({ reviews: ['manage'] }), intakeController.logIntake);
intake_route.get('/:id', requirePermissions({ reviews: ['read'] }), intakeController.getIntake);
intake_route.patch('/:id', requirePermissions({ reviews: ['manage'] }), intakeController.patchIntake);
intake_route.delete('/:id', requirePermissions({ reviews: ['manage'] }), intakeController.deleteIntake);
// The transitions (BS#2798). `reviews: write` is the gate on release, accept and
// pass; manage only lifts release's holder condition, and accept/pass identity
// is a condition inside the UPDATE (intake.service.ts).
intake_route.post('/:id/checkout', requirePermissions({ reviews: ['write'] }), intakeController.checkoutIntake);
intake_route.post('/:id/release', requirePermissions({ reviews: ['write'] }), intakeController.releaseIntake);
intake_route.post('/:id/request', requirePermissions({ reviews: ['manage'] }), intakeController.requestIntake);
intake_route.post(
  '/:id/cancel-request',
  requirePermissions({ reviews: ['manage'] }),
  intakeController.cancelIntakeRequest
);
intake_route.post('/:id/accept', requirePermissions({ reviews: ['write'] }), intakeController.acceptIntake);
intake_route.post(
  '/:id/accept-review',
  requirePermissions({ reviews: ['manage'] }),
  intakeController.acceptReviewIntake
);
intake_route.post('/:id/pass', requirePermissions({ reviews: ['write'] }), intakeController.passIntake);
// Filing creates catalog rows, so it takes both grants (BS#2803).
intake_route.post(
  '/:id/file',
  requirePermissions({ reviews: ['manage'], catalog: ['write'] }),
  intakeController.fileIntake
);
// Print appends to the print log; finalize is the librarian's step, so it takes `catalog: write` alone (BS#2804).
intake_route.post('/:id/print', requirePermissions({ reviews: ['manage'] }), intakeController.printIntake);
intake_route.post('/:id/finalize', requirePermissions({ catalog: ['write'] }), intakeController.finalizeIntake);
