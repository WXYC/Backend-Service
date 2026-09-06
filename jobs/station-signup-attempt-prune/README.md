# @wxyc/station-signup-attempt-prune

Daily EC2-cron job (BS#2363, split from `jobs/station-signup-review` / BS#2364) that deletes `station_signup_attempt` rows older than the 30-day audit retention window.

## What it does

`job.ts` calls the already-exported `pruneSignupAttempts` (`shared/authentication/src/station-passcode.ts`) with its default 30-day retention and logs the deleted-row count. No dry-run, no batching, no paging — this is a single `DELETE ... WHERE attempted_at < cutoff` statement against a table bounded by the retention window itself, not an unbounded backlog.

`station_signup_attempt` is the audit trail answering "who revealed the code?" and "what did the attack look like?" for the station passcode signup flow (BS#2359). It is retained 30 days, then pruned — `station_passcode` itself is never touched by this job.

## Why a separate job from `station-signup-review`

The failure consequences differ: a failed prune just means a larger table (self-correcting once the underlying cause is fixed and the next run's cutoff moves past the backlog); a failed `station-signup-review` run means a silent manager-review queue and, eventually, a stuck privilege downgrade — a security-relevant gap. Those two failure modes want separate alerting, so BS#2363 split the prune out of the review job rather than adding it as a fifth phase there.

## Retention boundary

`pruneSignupAttempts({ olderThanDays, now })` deletes rows with `attempted_at < now - olderThanDays days` — strictly older than the cutoff, so a row exactly at the cutoff instant survives. `tests/integration/station-signup-attempt-prune.spec.js` pins both sides of that boundary against real Postgres, plus the no-op case where every row is within the window.

`pruneSignupAttempts` returns the driver's affected-row count (`deleted.count`), not a list of ids — the ids were never used for anything but `.length`, and shipping a full month of attempt-log ids back over the wire to count them would be real transfer and allocation for a number Postgres already reports.

## Cron registration

Registered in `docs/ops-cron-scheduling.md`'s "Excluded / DB-only" section, not the LML slot table — this job never calls `@wxyc/lml-client` and cannot trip the breaker, so it is not a scheduling constraint that policy governs.
