import { roleGrants } from '@wxyc/authentication';
import type { Request } from 'express';

/** Whether the caller holds `reviews: manage`: the music director's verbs, and the lift on the DJ-only limits in `/intake` and `/reviews`. */
export const holdsReviewsManage = (req: Pick<Request, 'auth'>): boolean =>
  roleGrants(req.auth?.role, { reviews: ['manage'] });
