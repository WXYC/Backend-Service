import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as concertsController from '../controllers/concerts.controller.js';

export const concerts_route = Router();

// List: anonymous session auth (any valid JWT, no permission scope) — matches
// the /proxy iOS read surfaces. See BS#1603. Applied per-route rather than
// router-wide so the by-id read below can opt out (the config route's
// public/authed split is the in-repo precedent; BS#1682 tracks the same tier
// question for /library/genres).
concerts_route.get('/', requirePermissions({}), concertsController.getConcerts);

// By-id: deliberately PUBLIC — no auth middleware of any kind (BS#1694,
// wxyc-shared#236). Consumed by the wxyc.org/shows/<id> share Worker (which
// has no sane path to minting anonymous sessions) and the iOS universal-link
// fallback; responses are publicly cacheable, so no per-session variance is
// permitted here anyway.
concerts_route.get('/:id', concertsController.getConcertById);
