import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as fccNotesController from '../controllers/fcc-notes.controller.js';

export const fcc_notes_route = Router();

// Any DJ may report against any release or item (`reviews: write`, no hold rule) and every DJ may read them
// (`reviews: read`; the waiting list, `status=reported` with no subject, is checked for `reviews: manage` in the
// controller). A music director confirms (`reviews: manage`); `reviews: write` deletes, and the service lets a caller
// without `reviews: manage` delete only their own still-reported note. Pinned by tests/unit/routes/fcc-notes-permissions.route.test.ts —
// the integration tier runs AUTH_BYPASS=true and cannot see these gates.
fcc_notes_route.get('/', requirePermissions({ reviews: ['read'] }), fccNotesController.listFccNotes);
fcc_notes_route.post('/', requirePermissions({ reviews: ['write'] }), fccNotesController.createFccNote);
fcc_notes_route.post('/:id/confirm', requirePermissions({ reviews: ['manage'] }), fccNotesController.confirmFccNote);
fcc_notes_route.delete('/:id', requirePermissions({ reviews: ['write'] }), fccNotesController.deleteFccNote);
