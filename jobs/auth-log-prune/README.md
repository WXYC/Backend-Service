# @wxyc/auth-log-prune

Renamed from `station-signup-attempt-prune` in WXYC/Backend-Service#2535 — EC2/ECR/Sentry artifacts predating the rename carry the old name.

Daily EC2-cron job (BS#2363, split from `jobs/station-signup-review` / BS#2364; extended by BS#2536, parent epic #2534) that deletes two audit tables' rows older than their own retention windows: `station_signup_attempt` (30 days) and `account_audit_event` (`ACCOUNT_AUDIT_RETENTION_DAYS`, default 730 — 2 years).

## What it does

`job.ts` runs two independent prune statements under separate try/catch blocks, so one table's prune failing never silently skips the other's:

- `pruneSignupAttempts` (`shared/authentication/src/station-passcode.ts`) with its default 30-day retention.
- `pruneAccountAuditEvents` (`shared/database/src/account-audit.ts`) with `olderThanDays` read from `ACCOUNT_AUDIT_RETENTION_DAYS` (default 730).

Each logs its own deleted-row count. No dry-run, no batching, no paging — each is a single `DELETE ... WHERE <cutoff column> < cutoff` statement against a table bounded by its own retention window, not an unbounded backlog. Either failure sets `process.exitCode = 1`; both prunes are always attempted regardless of the other's outcome.

`station_signup_attempt` is the audit trail answering "who revealed the code?" and "what did the attack look like?" for the station passcode signup flow (BS#2359). It is retained 30 days, then pruned — `station_passcode` itself is never touched by this job.

`account_audit_event` is the account-modification audit trail (parent epic #2534): who triggered a password reset, invite, role change, or other account modification, to whom, when, and whether it succeeded. 2-year retention — forensic questions at a student station surface on academic-year timescales.

## Why a separate job from `station-signup-review`

The failure consequences differ: a failed prune just means a larger table (self-correcting once the underlying cause is fixed and the next run's cutoff moves past the backlog); a failed `station-signup-review` run means a silent manager-review queue and, eventually, a stuck privilege downgrade — a security-relevant gap. Those two failure modes want separate alerting, so BS#2363 split the prune out of the review job rather than adding it as a fifth phase there.

## Retention boundary

`pruneSignupAttempts({ olderThanDays, now })` deletes rows with `attempted_at < now - olderThanDays days` — strictly older than the cutoff, so a row exactly at the cutoff instant survives. `tests/integration/auth-log-prune.spec.js` pins both sides of that boundary against real Postgres, plus the no-op case where every row is within the window.

`pruneSignupAttempts` returns the driver's affected-row count (`deleted.count`), not a list of ids — the ids were never used for anything but `.length`, and shipping a full month of attempt-log ids back over the wire to count them would be real transfer and allocation for a number Postgres already reports. `pruneAccountAuditEvents` mirrors the same cutoff-boundary and return-shape contract against `account_audit_event.occurred_at`; `tests/integration/auth-log-prune.spec.js` pins both sides of that boundary too.

## Cron registration

Registered in `docs/ops-cron-scheduling.md`'s "Excluded / DB-only" section, not the LML slot table — this job never calls `@wxyc/lml-client` and cannot trip the breaker, so it is not a scheduling constraint that policy governs.
