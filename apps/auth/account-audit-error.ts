/**
 * The shared account-audit error sink (simplify pass, code review BS#2537
 * PR #2545 follow-up). `account-audit-middleware.ts` and
 * `complete-onboarding.ts` each carried their own copy of
 * `Sentry.captureException(error, { tags: { subsystem: 'account-audit' } })`
 * — one leaf, one tag literal.
 *
 * `jobs/station-signup-review/orchestrate.ts` deliberately KEEPS its own
 * local literal rather than importing this: it's a different npm workspace
 * (jobs/* vs apps/auth), and importing across that boundary for one
 * constant isn't worth the coupling. Its inline call cross-references
 * `ACCOUNT_AUDIT_ERROR_TAG` by name in a comment so the string can't
 * silently drift there without a reader noticing.
 */
import * as Sentry from '@sentry/node';

export const ACCOUNT_AUDIT_ERROR_TAG = 'account-audit';

export const onAccountAuditError = (error: unknown): void => {
  Sentry.captureException(error, { tags: { subsystem: ACCOUNT_AUDIT_ERROR_TAG } });
};
