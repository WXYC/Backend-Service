import type { intakeItemStateEnum } from './schema.js';

/**
 * States past which an intake item is catalogued, so it can no longer be edited or deleted. The one spelling of the
 * set: `apps/backend`'s intake service re-exports it (its `filedStateSql` and the Drizzle reads), and the
 * album-reviews import, which cannot import `apps/backend`, reads it here.
 */
export const FILED_STATES: (typeof intakeItemStateEnum.enumValues)[number][] = ['filed', 'finalized'];
