import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as digitalArchiveController from '../controllers/digital-archive.controller.js';

export const digital_archive_route = Router();

// ROLE-GATED at `dj`+ (`digital_archive: ['listen']`, auth.roles.ts). The
// auto-DJ Space this endpoint presigns into is not a public surface — the
// legal boundary is "authenticated DJs" — so `member` (the pre-DJ tier) and
// anonymous sessions (no role claim) both 403 here, same posture as
// `/album-reviews`.
//
// Pinned by tests/unit/routes/digital-archive-permissions.route.test.ts,
// which wires the real middleware in. The integration suite runs
// AUTH_BYPASS=true, under which requirePermissions returns next() before any
// permission check, so it cannot exercise this gate.
digital_archive_route.use(requirePermissions({ digital_archive: ['listen'] }));

digital_archive_route.get('/albums/:id/playback', digitalArchiveController.getPlayback);
