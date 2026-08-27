/**
 * Refuse-by-default guard: this job is superseded and running it reverses a
 * privacy fix (BS#2281).
 *
 * `jobs/flowsheet-dj-name-scrub` deliberately CREATES `dj_name IS NULL` rows —
 * `dj_join` / `dj_leave` markers whose guest handle held a DJ's real name (the
 * joining guest is not recoverable from `shows`, so re-attributing them would
 * write the PRIMARY DJ's name instead), and orphan rows with no shows chain to
 * recompute from. This job fills `dj_name` WHERE it IS NULL from the shows
 * join, which refills exactly those rows and silently undoes the scrub.
 *
 * Two independent stops, because they cover different failure paths:
 *
 *   1. The root `Dockerfile.<job>` has been removed, so `Manual Build & Deploy`
 *      cannot produce a NEW image.
 *   2. This runtime refusal, which stops an EXISTING image — one already in
 *      ECR, or a `dist/` built on the box — from doing damage. Removing the
 *      Dockerfile alone would not have covered that, and both of these jobs
 *      have been built and run before.
 *
 * Deliberately NO override env var, unlike `jobs/flowsheet-etl`'s
 * `LEGACY_ETL_ALLOW_BACKWARDS_WRITE`. That job is retained for a genuine
 * future maintenance window; these two are not. Their purpose is complete —
 * the 0053 → backfill → 0054 chain has been applied and verified, and BS#1393's
 * remediation ran — so there is no legitimate re-run to leave a door open for.
 * Reviving one means reverting this guard under review, which is the point.
 *
 * The source stays in the tree because `docs/migrations.md` and
 * `docs/backfill-precondition-assertions.md` both cite the 0053 → backfill →
 * 0054 chain as the canonical precondition-guard pattern, and the run history
 * is referenced from several issues.
 */

export const SUPERSEDED_BY = 'jobs/flowsheet-dj-name-scrub';

export const supersededRefusalMessage = (jobName: string): string =>
  [
    `${jobName} is superseded and refuses to run.`,
    '',
    `Its predicate fills flowsheet.dj_name WHERE dj_name IS NULL. ${SUPERSEDED_BY}`,
    '(BS#2281) deliberately CREATES those NULLs: dj_join / dj_leave markers whose',
    'guest handle held a real name are nulled rather than re-attributed, and orphan',
    'rows have no shows chain to recompute from. Running this job refills them from',
    'the shows join — writing the PRIMARY DJ over a guest, and undoing the privacy',
    'fix.',
    '',
    'If you are here because BS#2281 describes the earlier remediation as',
    '"under-remediated": re-running this job does not fix that. It only ever filled',
    'NULLs, so it cleans nothing and reverses the scrub. Run',
    `${SUPERSEDED_BY} instead — dry-run by default.`,
    '',
    `See ${SUPERSEDED_BY}/README.md.`,
  ].join('\n');
