# metadata-no-match-digest

Daily EC2-cron digest: flags flowsheet playcuts LML genuinely couldn't match to a Discogs release, so a human can follow up on _why_ (typo? obscure artist genuinely not on Discogs? a library album that should have a Discogs link but doesn't?).

## Problem

Backend-Service enriches a flowsheet playcut asynchronously: the row is inserted `metadata_status='pending'`, a Postgres CDC notification wakes `apps/enrichment-worker`, which calls LML's bulk lookup and writes the result. When LML genuinely finds nothing, the row is durably stamped `flowsheet.metadata_status='enriched_no_match'`. That outcome is observable only as a Sentry span attribute today, and is deliberately _suppressed_ from any Sentry event (`SUPPRESSED_EMPTY_CAUSES` in the worker's handler) -- routine no-matches are expected on a freeform station and would be noise. This job is the push nobody had: a daily summary email.

## What it does

1. Reads the `cronjob_runs` watermark for `job_name='metadata-no-match-digest'` (`watermark.ts`).
2. Queries `flowsheet` for rows that became `enriched_no_match` since the watermark (`query.ts`), filtered and sorted on `flowsheet.updated_at` -- **never** `metadata_attempt_at`. The live CDC enrichment worker deliberately leaves `metadata_attempt_at` NULL on `enriched_no_match` rows (see the column's comment in `shared/database/src/schema.ts`), so filtering on it would surface almost nothing. A second bound requires the play itself to be recent (`flowsheet.add_time > playAgeCutoff`) -- see "Two-bound window: watermark vs. play recency" below.
3. If there is at least one miss, renders (`format.ts`) and sends **one** HTML+text digest email via SES (`email.ts`) to `DIGEST_RECIPIENT_EMAIL`, then advances the watermark to the run's start instant.
4. If there are zero misses, sends nothing but still advances the watermark -- no empty daily email, and the window doesn't get re-scanned next time.
5. If sending is disabled (`EMAIL_ENABLED=false`), it logs a preview of what it would have sent and does **not** advance the watermark -- an observe-only dry run, so a later real run still sees the misses.
6. The query is restricted to `entry_type='track'` and capped at `MAX_DIGEST_ROWS` (5000); `format.ts` further caps Section A's rendered lines at `SECTION_A_MAX` (200). Both are backstops against an unbounded email if the watermark ever stalls (repeated send failures, or the cron down for a long stretch); a capped run flags it in the header.
7. Read-only against `flowsheet`: no INSERT/UPDATE/DELETE, no schema migration.

## Email content

- Subject: `WXYC metadata gaps: {N} playcut(s) with no match — {YYYY-MM-DD}` (date in Pacific Time).
- Header: total count, split into catalog/rotation-linked vs freeform.
- **Section A -- Catalog/rotation-linked (investigate):** every rotation-linked row in full (`#id`, artist, track, album, label, DJ, show, start time), each with a synthesized Discogs search link. These are the surprising cases -- a library album with no Discogs match -- and feed the `rotation.discogs_release_id` backfill work.
- **Section B -- Freeform:** grouped by `artist_name`, count desc, top 25 artists plus "…and N more", each with a Discogs search link. Keeps the expected freeform long tail compact.
- Footer: the window bounds and a one-line reply-to-follow-up note.
- Discogs search URLs are synthesized inline: `https://www.discogs.com/search/?q={urlencode(artist + ' ' + track)}&type=release`.

## Reader calibration: the cache self-heals, the row does not (BS#2176)

`enriched_no_match` is a terminal `flowsheet.metadata_status`, and until BS#2176 nothing ever revisited a row once it landed there. It is tempting to read a row in this digest as low-priority because "a new add against the same (artist, album) will self-heal on the next discogs-etl rebuild" -- that is true of the **cache** (discogs-etl's next rebuild, or an LML matcher fix, can make the SAME lookup succeed for a brand-new playcut) but was, until BS#2176, false of the **row already sitting in this digest**: nothing re-asked LML for it, so a row this digest reported last month could still be silently wrong today even though the identical (artist, album, track) tuple would now resolve.

`jobs/flowsheet-no-match-recheck` (BS#2176) closes that gap: a recurring, bounded, TTL-gated sweep re-asks LML for the whole `enriched_no_match` cohort, not just newly-inserted rows, so a row this digest already reported does eventually get revisited and, if now resolvable, flips to `enriched_match` on its own. Concretely: `flowsheet` row **#5308981** (`Vladislav Delay -- Kohde / Entain`), the case that motivated this correction, appeared in the 2026-08-16 digest, was still `enriched_no_match` when checked the next day, and matches when replayed against prod LML -- exactly the row/cache distinction above.

This does **not** make Section A/B stale reading -- a row appearing here is still real signal at the moment of the digest (LML did not match it _then_) -- but a reader should not assume a row's presence here implies anything about whether it is STILL unmatched days or weeks later. Check `flowsheet.metadata_status` directly (or wait for the recheck sweep's own TTL cadence, `docs/ops-cron-scheduling.md`) rather than assuming self-heal from a new add alone.

## Watermark semantics

`runStart = new Date()` is captured **before** the query runs. The watermark (`cronjob_runs.last_run`) advances to `runStart` on a successful send **or** a 0-row run. It is **not** advanced on a send failure (the next run retries the exact same window, and `orchestrate.ts`'s `run()` rethrows so `job.ts` exits non-zero and captures the failure to Sentry exactly once) **or** on a disabled observe-only run (so a later real run still sees the misses).

First run (no `cronjob_runs` row yet) bounds the window to the last `FIRST_RUN_WINDOW_HOURS` (24h, one cadence period) instead of dumping the entire historical backlog into one email.

### `updated_at` re-report caveat

The query's lower bound is `flowsheet.updated_at > :last_run`. `updated_at` is bumped by the `bump_flowsheet_updated_at` trigger (migration 0084) on **any** write to the row, not only the status flip to `enriched_no_match`. A row that flips to `enriched_no_match` is always caught by the next digest (the flip is itself an UPDATE that bumps `updated_at`), but a no-match row that is later touched for an unrelated reason (e.g. a future remediation script backfilling an unrelated column) will bump `updated_at` again and can re-appear in a subsequent digest even though its `metadata_status` didn't change on that write. This is an acceptable minor over-report for a periodic summary -- it is not a correctness bug in the enrichment pipeline, and there is no `notified_at` per-row marker (a possible future follow-up; the periodic watermark is sufficient for this job's purpose).

### Two-bound window: watermark vs. play recency (BS#1921)

The `updated_at` re-report caveat above is a _minor_ over-report. A _running backfill_ is a much bigger one: any job that re-enriches old `flowsheet` rows (the `flowsheet-metadata-backfill` historical drain, a scoped re-enrichment like BS#1823) flips them to `enriched_no_match`, which bumps `updated_at` to now via the same trigger -- so every re-touched row, however old the play, falls inside the next digest window. Observed 2026-08-01: a backfill drain produced 5,800+ `enriched_no_match` rows in one run, all months-old plays, drowning the digest's actual signal (new plays that genuinely didn't match).

The fix is a second, independent bound in `query.ts`: `flowsheet.add_time > playAgeCutoff`, where `playAgeCutoff = runStart - DIGEST_MAX_PLAY_AGE_HOURS` (`watermark.ts`'s `resolvePlayAgeCutoff`, default 48h). The two bounds do different jobs -- `updated_at > since` is still the window/watermark (catches a row newly _flipped_ to no-match since the last run), while `add_time > playAgeCutoff` requires the play itself to be recent. A backfill re-touching an old play (old `add_time`, fresh `updated_at`) is excluded; a genuinely new play the CDC worker missed and the C6 gap-recovery job (`flowsheet-metadata-backfill`, `BACKFILL_RECOVERY_WINDOW_HOURS`, default 6h) later enriched to no-match still surfaces (its `add_time` is recent).

**Config coupling:** the real floor is `DIGEST_MAX_PLAY_AGE_HOURS ≥ BACKFILL_RECOVERY_WINDOW_HOURS + digest cadence (~24h) + margin`, not just `≥ BACKFILL_RECOVERY_WINDOW_HOURS`. A C6-recovered row can already be up to `BACKFILL_RECOVERY_WINDOW_HOURS` old (its `add_time`) by the moment it flips to `enriched_no_match`, and that flip then has to wait for the _next_ daily digest run to be read -- up to another ~24h (the job's own cadence, `package.json`'s `cron-schedule`). So a legitimately-recovered row's `add_time` can be ~(recovery window + ~24h) old by the time the digest that would catch it runs. With the defaults (6h recovery + ~24h cadence ≈ 30h worst case vs. the 48h cutoff) this holds with an ~18h margin, not the 42h a naive `48 ≥ 6` reading suggests. If the C6 recovery window is ever widened for a deliberate catch-up pass, or the digest cadence changes, recompute the floor and bump `DIGEST_MAX_PLAY_AGE_HOURS` to match -- otherwise a row C6 legitimately recovers can silently vanish from the digest.

**Known residual gaps (accepted, not blockers):**

- `add_time` only excludes backfills of _old_ plays. A re-enrichment touching _recent_ rows (`add_time` younger than `DIGEST_MAX_PLAY_AGE_HOURS`) would still leak into the digest -- there is no clean query-only fix, since AND-ing `metadata_attempt_at IS NULL` to close it would also drop genuinely-new no-matches the C6 gap-recovery job stamps (it sets `metadata_attempt_at` even on a real new play). The operational answer is to coordinate/pause such a recent-scoped drain, or accept one noisy digest.
- The reverse direction narrows too: if the digest cron itself is down longer than `DIGEST_MAX_PLAY_AGE_HOURS` (the stalled-cron scenario `MAX_DIGEST_ROWS`'s own doc comment anticipates), a genuinely new no-match whose `add_time` has aged past the cutoff by the time the cron recovers is silently excluded from that catch-up run, even though the `updated_at` watermark still spans it -- a real behavior change from the prior watermark-only query. Accepted for the same reason as the cutoff itself exists: a stalled-cron catch-up digest is already the degenerate case, and widening the play-age window to cover it would defeat the window's whole purpose.

### DST wall-clock / label drift

`package.json`'s `cron-schedule` is `07 15 * * *` -- 15:07 **UTC**, fixed year-round (EC2 crontab has no DST awareness). That's 08:07 **PDT** in the summer and 07:07 **PST** in the winter. Every timestamp in the email body is rendered in Pacific Time via `formatPacificDateTime`/`formatPacificDate` (`format.ts`), always labeled generically `PT` (never `PST`/`PDT`, so the label itself never needs to change) -- but the _wall-clock hour_ the digest lands at, and the calendar date in the subject line near local midnight, silently shifts by one hour across each DST boundary. This is expected: the job doesn't adjust its own UTC schedule for DST, so nobody should be surprised the "08:07 AM" digest becomes a "07:07 AM" digest in November.

## Environment variables

See `docs/env-vars.md` for the full reference. This job uses:

- `DIGEST_RECIPIENT_EMAIL` (default `jake@wxyc.org`) -- the digest recipient.
- `DIGEST_MAX_PLAY_AGE_HOURS` (default `48`) -- play-recency ceiling on `flowsheet.add_time`; see "Two-bound window" above. Positive integer via `requirePositiveInt`; `0` is rejected (it would blackhole the digest to empty forever, unlike `flowsheet-metadata-backfill`'s `BACKFILL_RECOVERY_WINDOW_HOURS` where `0` is a meaningful "disable the ceiling" setting).
- `SES_FROM_EMAIL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` -- SES send config (shared with the auth service's transactional email).
- `SES_CONFIGURATION_SET_NAME` (optional) -- set as `ConfigurationSetName` on the `SendEmailCommand` when present.
- `EMAIL_ENABLED` (default enabled) -- set `false` for an observe-only run: `sendDigestEmail` short-circuits before any SES client is constructed (and without requiring `SES_FROM_EMAIL`), the job logs a preview of what it would have sent, and the watermark is left unadvanced. Test/CI always run with this `false` (`tests/setup/unit.setup.ts`).
- `WXYC_SCHEMA_NAME` (default `wxyc_schema`) -- schema-qualifies the raw digest query so parallel Jest workers on per-schema DBs don't collide.
- Standard DB connection vars (`DB_HOST`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`, `DB_PORT`) and `SENTRY_DSN` (optional).

## Local run

```bash
docker run --rm --env-file .env <ECR-URI>/metadata-no-match-digest:<tag>
```

or, from the repo root with dependencies built:

```bash
npm --workspace=jobs/metadata-no-match-digest run start
```

Point `DB_*` at a snapshot (or prod -- the job is read-only) and leave `EMAIL_ENABLED=false` for an observe-only dry run: it logs a preview of the digest it would have sent and leaves the watermark unadvanced, so it doesn't consume the window a real run needs.

## Files

- `job.ts` -- thin process entrypoint: init logging, run once, capture any failure to Sentry once, always close the DB pool + logger.
- `orchestrate.ts` -- the `run()` spine (watermark read → window resolve → query → render → send-or-skip → conditional watermark advance), separated from `job.ts` so it's unit-testable without the module-load `void main()`.
- `query.ts` -- the digest SQL (`updated_at`- and `add_time`-keyed, `entry_type='track'`, `LIMIT MAX_DIGEST_ROWS`) + `NoMatchRow` row type + the `unwrapRows` result-shape guard. Both the `> :since` and `> :playAgeCutoff` bounds are pre-stringified (`${d.toISOString()}::timestamptz`) and the timestamps are selected as `extract(epoch ...)` and rebuilt into `Date`s, because `@wxyc/database`'s Drizzle client rebinds the postgres-js date-family parser **and** serializer to a passthrough: a raw JS `Date` param throws inside postgres-js's `Bind`, and timestamptz reads come back as strings (see the file header and `feedback_drizzle_date_serializer_override`). Compiled to `dist/query.cjs` (tsup cjs entry) so the integration spec runs the REAL function through that driver.
- `format.ts` -- pure rendering (subject, sections, grouping, Discogs URL synthesis, PT time formatting). No DB/network; heavily unit-tested.
- `watermark.ts` -- `cronjob_runs` read/write + the first-run window bound + the play-age cutoff resolver (`resolvePlayAgeCutoff`) + the advance-on-success/no-advance-on-failure decision.
- `email.ts` -- self-contained SES sender (does not import `@wxyc/authentication` -- see the header comment for why).
- `logger.ts` -- standard job logger (Sentry init + JSON logs), copied per the repo's per-job duplication convention.
