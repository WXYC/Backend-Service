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
