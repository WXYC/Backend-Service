# @wxyc/station-signup-review

Daily EC2-cron job (BS#2364, station-signup-review plan) covering the two failure modes the epic identified in manual review of self-signed-up accounts: nobody notices a pending queue, and a self-signed account keeps `dj` (flowsheet write access) indefinitely if it's ignored.

## What it does

Every run reads the same cohort — every `auth_user` row where `self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL` (`query.ts`) — and runs four phases against it:

1. **Query** — the pending cohort. `self_signup_downgraded_at` is _selected_ but deliberately not filtered on: this is the digest's cohort, and it is the same cohort dj-site's roster review queue shows, so an already-downgraded account must keep appearing until a human reviews it.
2. **Plan** (`downgrade.ts`'s `planDowngrades`) — decide, per account and **without writing anything**, what happens today.
3. **Notify** (`format.ts` + `email.ts`) — email the digest to `STATION_SIGNUP_ALERT_EMAIL`, naming every pending account with the decision from phase 2, including the ones about to be downgraded. Zero pending accounts sends nothing.
4. **Apply** (`applyDowngrades`) — perform the writes.

### The six per-account outcomes

| Status               | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `pending`            | Inside the 30-day window. The digest shows a countdown.                                              |
| `downgraded`         | This run flips it `dj` → `member` and stamps `self_signup_downgraded_at`.                            |
| `already-downgraded` | A prior run flipped it. **Never re-fires.** The digest shows the date it happened.                   |
| `deferred-on-air`    | Overdue, but the account holds an open show — or the guard query itself failed. Nothing written.     |
| `downgrade-disabled` | Overdue, but `STATION_SIGNUP_DOWNGRADE_ENABLED` is not `'true'`.                                     |
| `already-member`     | Overdue and never downgraded by this job, but the account no longer holds `auth_member.role = 'dj'`. |

Each is a decision the job made, not a condition the digest re-derives. An earlier version inferred "already downgraded" from `days >= 30` alone, which conflated a prior-run downgrade with a manual role change and was an outright false statement under the kill switch or the on-air guard.

## When it fires

**At 30 days, inclusive** — `now - self_signup_at >= 30d`, not "more than 30 days". The issue's acceptance criterion is "fires at 30 days"; `isPastDowngradeCutoff` is `>=` and `downgrade.test.ts` pins both sides of the boundary instant.

**Why 30 days:** it exceeds any holiday break, so the downgrade cannot fire mid-break and strand a working DJ. It only ever catches accounts nobody reviewed _after_ the break ended.

## The kill switch

`STATION_SIGNUP_DOWNGRADE_ENABLED`, strict `=== 'true'`, **defaulting OFF** — the same convention as `DONATE_ENABLED` / `DIGITAL_ARCHIVE_STREAMING_ENABLED` / `FLOWSHEET_TAKEOVER_ENABLED`, hand-rolled in `downgrade.ts` rather than imported because a `jobs/*` workspace does not depend on `apps/backend`.

Off, the digest still runs and still names every overdue account as `downgrade-disabled`, so disarming the actuator never makes the station less informed.

Cron jobs run as `docker run --env-file .env`, one process per run, so the value is re-read on every run: flipping it in the host's `~/.env` takes effect on the next scheduled run with **no restart of anything**. (Both `STATION_SIGNUP_*` keys are in `.github/workflows/set-ec2-env-var.yml`'s allowlist; that workflow's container restart is collateral for these two keys, not the mechanism.)

## The on-air guard

An overdue account holding an **open show** (`shows.end_time IS NULL AND (primary_dj_id = userId OR EXISTS (show_djs …))`, served by the partial index `shows_open_start_time_idx` from migration 0154) is skipped and deferred to the next run.

This matters more than it looks. `POST /flowsheet/end` requires `flowsheet: ['write']`, and the JWT resolves the caller's role live on a ~15-minute expiry — so a DJ demoted mid-show **cannot sign off**. Their abandoned open show then swallows every later DJ's go-live as a silent guest join, because `POST /flowsheet/join` routes start-vs-join on `current_show?.end_time !== null`. That is the corruption `jobs/flowsheet-show-split` repairs by hand, non-re-runnably. A one-day delay costs nothing.

**If the guard query itself errors, the account is deferred, not downgraded.** An unanswerable question fails toward "wait", never toward a privilege change — the epic's governing constraint.

Deliberately not a "recent flowsheet writes" heuristic: a flowsheet write requires an open show, so the open-show check subsumes it.

## Notify-first, but the write is not gated on the send

The digest goes out before the writes so it can never be a claim about a privilege change the operator was not told about first. It is deliberately **not** a precondition of them: gating the write on a successful send would couple the backstop to the very channel it exists to back up, and an unset `SES_FROM_EMAIL` or an exhausted SES quota would mean nobody is ever downgraded, silently, looking exactly like "nothing was overdue".

The digest is level-triggered — the same account reappears every day until a human reviews it — so a failed send costs one day of awareness and nothing else. The run still exits non-zero on a send failure, after the writes have been attempted.

## Why this write path is safe

Directly writing `auth_member.role` bypasses better-auth's own role-change hooks. That's safe **only for this specific role pair**: `grantsAdminFlag` (`shared/authentication/src/admin-flag-sync.ts`) is `normalizeRole(role) === 'stationManager'`, so neither `dj` nor `member` ever touches the `auth_user.role='admin'` flag — no hook needs to fire for this write to be complete.

**This does not generalize.** Reusing this bare-write pattern for any pair involving `stationManager` would desync the admin flag silently. See WXYC/Backend-Service#2171 for the standing `auth_user.role` / `auth_member.role` drift this relies on not making worse. `tests/unit/jobs/station-signup-review/downgrade.test.ts` pins that the write never touches `auth_user.role` in any form.

The **only** `auth_user` column this job writes is `self_signup_downgraded_at`, and the role flip and that stamp share one transaction — half of the pair is a defect either way.

## Reversibility, and why the marker exists

The downgrade never deletes and never bans — it's a single roster role edit, reversible by any manager promoting the account back to `dj`.

That promise used to be a trap. The downgrade deliberately does **not** stamp `self_signup_reviewed_at`, because that column is the manager's review queue, shared verbatim with dj-site's roster predicate; stamping it would empty the queue and make the account permanently invisible. So a downgraded account never left the cohort, satisfied the 30-day cutoff and the `WHERE role = 'dj'` guard again the moment a manager re-promoted it, and was demoted again the next morning — forever.

`auth_user.self_signup_downgraded_at` (migration 0161) closes that: the downgrade pass adds `AND self_signup_downgraded_at IS NULL` and stamps it in the same transaction as the role flip. **The actuator fires at most once per account**, a manager's re-promotion durably sticks, and the digest keeps nagging daily until a human actually reviews.

The marker is never cleared by this job. BS#2362's approve endpoint should let it survive approval, as the record of what happened to the account.

## No watermark

Unlike `jobs/metadata-no-match-digest` (its structural donor), this job carries no `cronjob_runs` watermark. The digest is a point-in-time snapshot of "what's pending right now," re-sent daily for as long as something is pending — not a "what's new since last time" feed. There's no partial window to reconcile.

## Tests

`tsup` emits `dist/query.cjs` and `dist/downgrade.cjs` alongside the ESM entrypoint so `tests/integration/station-signup-review.spec.js` can `require` and run the **real** predicates against real Postgres. That is not polish: every unit suite in this repo mocks `drizzle-orm` wholesale, so a mocked predicate is only ever asserted as the shape of a mock argument — for the one job in the fleet that changes privileges. The integration spec is what pins that a second run is a genuine no-op. Rebuild after editing either file (`npm run build --workspace=@wxyc/station-signup-review`).

## Environment

See [`docs/env-vars.md`](../../docs/env-vars.md) for `STATION_SIGNUP_ALERT_EMAIL`, `STATION_SIGNUP_DOWNGRADE_ENABLED`, and the shared SES vars (`SES_FROM_EMAIL`, `SES_CONFIGURATION_SET_NAME`, `EMAIL_ENABLED`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`).

`STATION_SIGNUP_ALERT_EMAIL` falls back to a built-in default rather than failing loudly — an unset variable must not kill the safety-net digest during exactly the weeks nobody is watching — but the fallback announces itself in a `warn` log line **and** in the digest body.

## Cron registration

Registered in the "Excluded / DB-only" section of [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md) — this job reads/writes only `auth_user`/`auth_member` (plus a `shows`/`show_djs` read for the on-air guard) and sends via SES, with no `@wxyc/lml-client` dependency, so it can't trip the LML circuit breaker and isn't subject to the LML slot-spacing policy.
