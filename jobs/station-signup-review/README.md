# @wxyc/station-signup-review

Daily EC2-cron job (BS#2364, station-signup-review plan) covering the two failure modes the epic identified in manual review of self-signed-up accounts: nobody notices a pending queue, and a self-signed account keeps `dj` (flowsheet write access) indefinitely if it's ignored.

## What it does

Every run reads the same cohort — every `auth_user` row where `self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL` (`query.ts`) — and does two things against it:

1. **Downgrade** (`downgrade.ts`) — any account pending for more than `DOWNGRADE_AFTER_DAYS` (30) has its `auth_member.role` written directly from `'dj'` to `'member'`. Guarded `WHERE role = 'dj'`, so an account already downgraded by a prior run, or already promoted/reviewed out of `dj` some other way, is a no-op.
2. **Digest** (`format.ts` + `email.ts`) — while anything is pending, email a summary to `STATION_SIGNUP_ALERT_EMAIL` naming every pending account, its days-pending, and (for accounts this run just downgraded) that fact. Zero pending accounts sends nothing.

The downgrade pass runs before the digest is built, so the digest can name the accounts downgraded _this run_ without independently re-deriving the 30-day cutoff.

## Why 30 days

It exceeds any holiday break, so the downgrade cannot fire mid-break and strand a working DJ. It only ever catches accounts nobody reviewed _after_ the break ended.

## Why this write path is safe

Directly writing `auth_member.role` bypasses better-auth's own role-change hooks. That's safe **only for this specific role pair**: `grantsAdminFlag` (`shared/authentication/src/admin-flag-sync.ts`) is `normalizeRole(role) === 'stationManager'`, so neither `dj` nor `member` ever touches the `auth_user.role='admin'` flag — no hook needs to fire for this write to be complete.

**This does not generalize.** Reusing this bare-write pattern for any pair involving `stationManager` would desync the admin flag silently. See WXYC/Backend-Service#2171 for the standing `auth_user.role` / `auth_member.role` drift this relies on not making worse. `tests/unit/jobs/station-signup-review/downgrade.test.ts` pins that the write never touches `auth_user` in any form.

## Reversibility

The downgrade never deletes and never bans — it's a single roster role edit, reversible by any manager promoting the account back to `dj`.

## No watermark

Unlike `jobs/metadata-no-match-digest` (its structural donor), this job carries no `cronjob_runs` watermark. The digest is a point-in-time snapshot of "what's pending right now," re-sent daily for as long as something is pending — not a "what's new since last time" feed. A send failure is simply retried in full on the next daily run; there's no partial window to reconcile.

## Environment

See [`docs/env-vars.md`](../../docs/env-vars.md) for `STATION_SIGNUP_ALERT_EMAIL` and the shared SES vars (`SES_FROM_EMAIL`, `SES_CONFIGURATION_SET_NAME`, `EMAIL_ENABLED`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`).

## Cron registration

Registered in the "Excluded / DB-only" section of [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md) — this job reads/writes only `auth_user`/`auth_member` and sends via SES, with no `@wxyc/lml-client` dependency, so it can't trip the LML circuit breaker and isn't subject to the LML slot-spacing policy.
