import { roleGrants } from '@wxyc/authentication';
import type { Request } from 'express';

/** Whether the caller holds `reviews: manage`: the music director's verbs, and the lift on the DJ-only limits in `/intake` and `/reviews`. */
export const holdsReviewsManage = (req: Pick<Request, 'auth'>): boolean =>
  roleGrants(req.auth?.role, { reviews: ['manage'] });

/** The caller of an `/intake` or `/reviews` request: their user id and whether they hold `reviews: manage`. */
export type ReviewsActor = { id: string; manage: boolean };

export const reviewsActor = (req: Pick<Request, 'auth'>): ReviewsActor => ({
  id: (req.auth?.id ?? req.auth?.sub) as string,
  manage: holdsReviewsManage(req),
});
