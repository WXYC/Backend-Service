import type { intake_items } from '@wxyc/database';

/**
 * Whether an item, read under its row lock, may be filed: a music director has accepted a review for it. A citation
 * does not stand in for one (decision 37; it only makes the cited release's reviews available to accept), so this
 * never consults it. Written once, for `POST /intake/{id}/file` and for the review gate's `intake` basis (BS#2807).
 *
 * A leaf module: `intake.service` and `library.service` both need it, and `library.service` importing `intake.service`
 * would close an import cycle through `library-filing.service`.
 */
export const mayFileItem = (item: Pick<typeof intake_items.$inferSelect, 'accepted_review_id'>) =>
  item.accepted_review_id !== null;
