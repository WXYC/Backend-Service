# metadata-no-match-digest

Daily EC2-cron digest: flags flowsheet playcuts LML genuinely couldn't match to a Discogs release, so a human can follow up on _why_ (typo? obscure artist genuinely not on Discogs? a library album that should have a Discogs link but doesn't?).

## Problem

Backend-Service enriches a flowsheet playcut asynchronously: the row is inserted `metadata_status='pending'`, a Postgres CDC notification wakes `apps/enrichment-worker`, which calls LML's bulk lookup and writes the result. When LML genuinely finds nothing, the row is durably stamped `flowsheet.metadata_status='enriched_no_match'`. That outcome is observable only as a Sentry span attribute today, and is deliberately _suppressed_ from any Sentry event (`SUPPRESSED_EMPTY_CAUSES` in the worker's handler) -- routine no-matches are expected on a freeform station and would be noise. This job is the push nobody had: a daily summary email.

## What it does

1. Reads the `cronjob_runs` watermark for `job_name='metadata-no-match-digest'` (`watermark.ts`).
2. Queries `flowsheet` for rows that became `enriched_no_match` since the watermark (`query.ts`), filtered and sorted on `flowsheet.updated_at` -- **never** `metadata_attempt_at`. The live CDC enrichment worker deliberately leaves `metadata_attempt_at` NULL on `enriched_no_match` rows (see the column's comment in `shared/database/src/schema.ts`), so filtering on it would surface almost nothing.
3. If there is at least one miss, renders (`format.ts`) and sends **one** HTML+text digest email via SES (`email.ts`) to `DIGEST_RECIPIENT_EMAIL`, then advances the watermark to the run's start instant.
4. If there are zero misses, sends nothing but still advances the watermark -- no empty daily email, and the window doesn't get re-scanned next time.
5. Read-only against `flowsheet`: no INSERT/UPDATE/DELETE, no schema migration.

## Email content

- Subject: `WXYC metadata gaps: {N} playcut(s) with no match — {YYYY-MM-DD}` (date in Pacific Time).
- Header: total count, split into catalog/rotation-linked vs freeform.
- **Section A -- Catalog/rotation-linked (investigate):** every rotation-linked row in full (`#id`, artist, track, album, label, DJ, show, start time), each with a synthesized Discogs search link. These are the surprising cases -- a library album with no Discogs match -- and feed the `rotation.discogs_release_id` backfill work.
- **Section B -- Freeform:** grouped by `artist_name`, count desc, top 25 artists plus "…and N more", each with a Discogs search link. Keeps the expected freeform long tail compact.
- Footer: the window bounds and a one-line reply-to-follow-up note.
- Discogs search URLs are synthesized inline: `https://www.discogs.com/search/?q={urlencode(artist + ' ' + track)}&type=release`.

## Watermark semantics

`runStart = new Date()` is captured **before** the query runs. The watermark (`cronjob_runs.last_run`) advances to `runStart` on a successful send **or** a 0-row run. On a send failure, the watermark is **not** advanced, so the next run retries the exact same window (`job.ts`'s `run()` still exits non-zero so the failure is visible in the container's exit code / Sentry).

First run (no `cronjob_runs` row yet) bounds the window to the last `FIRST_RUN_WINDOW_HOURS` (24h, one cadence period) instead of dumping the entire historical backlog into one email.

### `updated_at` re-report caveat

The query's lower bound is `flowsheet.updated_at > :last_run`. `updated_at` is bumped by the `bump_flowsheet_updated_at` trigger (migration 0084) on **any** write to the row, not only the status flip to `enriched_no_match`. A row that flips to `enriched_no_match` is always caught by the next digest (the flip is itself an UPDATE that bumps `updated_at`), but a no-match row that is later touched for an unrelated reason (e.g. a future remediation script backfilling an unrelated column) will bump `updated_at` again and can re-appear in a subsequent digest even though its `metadata_status` didn't change on that write. This is an acceptable minor over-report for a periodic summary -- it is not a correctness bug in the enrichment pipeline, and there is no `notified_at` per-row marker (a possible future follow-up; the periodic watermark is sufficient for this job's purpose).

### DST wall-clock / label drift

`package.json`'s `cron-schedule` is `07 15 * * *` -- 15:07 **UTC**, fixed year-round (EC2 crontab has no DST awareness). That's 08:07 **PDT** in the summer and 07:07 **PST** in the winter. Every timestamp in the email body is rendered in Pacific Time via `formatPacificDateTime`/`formatPacificDate` (`format.ts`), always labeled generically `PT` (never `PST`/`PDT`, so the label itself never needs to change) -- but the _wall-clock hour_ the digest lands at, and the calendar date in the subject line near local midnight, silently shifts by one hour across each DST boundary. This is expected: the job doesn't adjust its own UTC schedule for DST, so nobody should be surprised the "08:07 AM" digest becomes a "07:07 AM" digest in November.

## Environment variables

See `docs/env-vars.md` for the full reference. This job uses:

- `DIGEST_RECIPIENT_EMAIL` (default `jake@wxyc.org`) -- the digest recipient.
- `SES_FROM_EMAIL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` -- SES send config (shared with the auth service's transactional email).
- `SES_CONFIGURATION_SET_NAME` (optional) -- set as `ConfigurationSetName` on the `SendEmailCommand` when present.
- `EMAIL_ENABLED` (default enabled) -- set `false` to short-circuit before any SES client is constructed. Test/CI always run with this `false` (`tests/setup/unit.setup.ts`).
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

Point `DB_*` at a snapshot (never prod without read-only intent understood) and leave `EMAIL_ENABLED=false` for a dry run that still logs what it would have sent.

## Files

- `job.ts` -- entrypoint: watermark read → window resolve → query → render → send (if any rows) → conditional watermark advance.
- `query.ts` -- the digest SQL + `NoMatchRow` row type.
- `format.ts` -- pure rendering (subject, sections, grouping, Discogs URL synthesis, PT time formatting). No DB/network; heavily unit-tested.
- `watermark.ts` -- `cronjob_runs` read/write + the first-run window bound + the advance-on-success/no-advance-on-failure decision.
- `email.ts` -- self-contained SES sender (does not import `@wxyc/authentication` -- see the header comment for why).
- `logger.ts` -- standard job logger (Sentry init + JSON logs), copied per the repo's per-job duplication convention.
