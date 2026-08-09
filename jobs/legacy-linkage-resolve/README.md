# legacy-linkage-resolve

Links `flowsheet` and `rotation` rows to their library album once the `library` row exists.

## Why this job exists

Both webhook writers resolve `album_id` exactly once, at write time, against whatever `library` held at that instant:

- `/internal/flowsheet-webhook` resolves on INSERT and deliberately **never** refreshes on conflict — linkage is anchored to the first delivery.
- `/internal/rotation-webhook` resolves once via `resolveAlbumId(rawLibraryId)`.

That is a race against `jobs/library-etl/`, which imports the catalog on its own `*/30` schedule, and against the librarian, who routinely files the physical release _after_ the music director bins it. A row whose library row lands second keeps `album_id = NULL` — and, on `rotation`, keeps its denormalized `artist_name` / `album_title` / `record_label` — permanently, because nothing else ever re-runs the join.

Until Phase 3 of the tubafrenzy decommission ([WXYC/wiki#88](https://github.com/WXYC/wiki/issues/88)), that repair ran as a tail pass inside `jobs/flowsheet-etl/` and `jobs/rotation-etl/` every 30 minutes. Those two jobs were unscheduled when Backend-Service became the canonical writer, because their _import_ half now writes **backwards** — from tubafrenzy's mirror copy onto Backend-canonical rows. Their repair half has no such problem: it reads and writes only Backend's own tables and never contacts tubafrenzy. This job is that repair half, lifted out verbatim so it survives the import's retirement.

Consumers of the linkage this restores: album metadata enrichment, the rotation badge JOIN, and the `rotation.discogs_release_id` backfill. Rows that stay unlinked fall into the free-text cohort instead.

## What it does

Two passes, both pure SQL, both anti-joined on `album_id IS NULL`:

| Pass        | Join                                                               | Writes                                                               |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `flowsheet` | `flowsheet.legacy_release_id` = `library.legacy_release_id`        | `album_id`                                                           |
| `rotation`  | `rotation.legacy_library_release_id` = `library.legacy_release_id` | `album_id`, and NULLs `artist_name` / `album_title` / `record_label` |

`ANALYZE` runs after any pass that actually wrote rows, per [`docs/bulk-update-playbook.md`](../../docs/bulk-update-playbook.md). The `flowsheet` UPDATE deliberately omits `updated_at` — migration 0084's trigger owns that column.

A run with nothing to fix is a no-op, and re-running is idempotent.

## Usage

```bash
node dist/job.js              # resolve (default)
node dist/job.js --dry-run    # report candidate counts, write nothing
```

Exits non-zero on failure so the cron surfaces it; errors are also captured to Sentry.

`--dry-run` deliberately emits **none** of the liveness signals below: it must not send a Sentry check-in Sentry would read as a scheduled execution, must not advance the heartbeat, and would trip the drain check trivially (it counts candidates and writes nothing by design).

## Environment

| Variable                        | Default | Purpose                                                                                                                                                                    |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                    | unset   | **Required for signal (a).** Without a DSN the SDK no-ops, so both the check-in and the warning-level signals silently vanish. Same DSN the existing `captureError` needs. |
| `LINKAGE_RESOLVE_MAX_GAP_HOURS` | `4`     | Hours between successful runs before the heartbeat gap is worth a warning. Eight consecutive missed runs at the `*/30` cadence.                                            |

## Schedule

`*/30 * * * *` UTC, from `package.json`'s `cron-schedule` — the same cadence the repair had inside the ETLs, and the same cadence as `library-etl`, which is what produces the library rows this job waits on. DB-only: no `@wxyc/lml-client` dependency, so it is exempt from the LML cron-spacing policy in [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md).

## Design notes

**No cooperative live-DJ pause.** The candidate set is bounded by the rows a webhook could not link and the writes are narrow. Deferring the repair indefinitely through a long show is worse than the contention it would avoid. This matches the behaviour the pass had inside the ETLs, which never paused either.

**No watermark — the `cronjob_runs` row is a heartbeat, not a delta bound.** Unlike the ETLs it was extracted from, this job does not track a watermark. Both statements are set-based over the current NULL cohort, so there is no delta to track and no watermark to go stale between runs.

Since [BS#2064](https://github.com/WXYC/Backend-Service/issues/2064) the job _does_ write a `cronjob_runs` row, and the distinction matters: that row is a **liveness heartbeat**, read only to report how long the job was away. **Nothing may ever read it back into a repair predicate.** A `last_run` filter on either SELECT would permanently strand any row whose `library` row landed during a window the job missed — which is the exact bug this job exists to prevent. Both statements are anti-joined on `album_id IS NULL` and nothing else; `tests/unit/jobs/legacy-linkage-resolve/job.test.ts` fails if a time predicate ever appears in them.

## Liveness

A healthy idle run writes nothing and logs `candidates: 0`. Before BS#2064 that made a cron which had **stopped running** byte-identical to one that ran and found nothing — and the only failure signal, `run()`'s `captureError`, covers just "the job ran and threw". It cannot see the failures that actually take a cron off a host: the crontab entry dropped by a deploy or a hand edit, the image failing to pull, docker wedged, the host rebooted.

Three signals now distinguish the cases. They are complementary, not redundant — each catches something the others miss.

| Signal                                             | Detects                                                         | Latency                                  | Survives                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| **(a)** Sentry cron monitor (`Sentry.withMonitor`) | The run did not happen at all                                   | ~40 min (30 min cadence + 10 min margin) | An error-quota exhaustion (check-ins are a separate Sentry quota category) |
| **(b)** `cronjob_runs` heartbeat + gap report      | A gap between successful runs                                   | Only once the job runs again             | Sentry being down entirely — the row is in Postgres                        |
| **(c)** Drain check                                | The job ran, checked in green, and did not repair what it found | Same run                                 | —                                                                          |

**(a) Sentry cron monitor.** The real run is wrapped in `Sentry.withMonitor(JOB_NAME, …, MONITOR_CONFIG)`, which sends an `in_progress` check-in on entry and `ok`/`error` on exit. Sentry raises a **missed check-in** when the expected check-in never arrives, which is precisely the failure mode a try/catch cannot see. The monitor is upserted from `MONITOR_CONFIG` on the first check-in — no manual setup in the Sentry UI. `checkinMargin: 10` min on the `*/30` cadence surfaces a skipped run ~40 min after its slot; `maxRuntime: 25` min sits under the cadence so a wedged run is flagged before the next one fires, and above the arithmetic worst case (four statements × the image's 5-minute `DB_STATEMENT_TIMEOUT_MS`). `withMonitor` re-throws, so the existing `captureError` path is unchanged.

`CRON_SCHEDULE` in `job.ts` must stay byte-identical to `package.json`'s `cron-schedule`, which is what `deploy-base.yml` installs in the crontab; a unit test pins the two together, since tsup does not bundle `package.json` into `dist/`.

**(b) `cronjob_runs` heartbeat.** Written via the fleet-standard `updateLastRun` after a successful run, inside the monitored callback so the check-in reports `ok` only when repair _and_ heartbeat committed. At the start of each run the job reads the previous value — purely to log the elapsed gap, and to warn above `LINKAGE_RESOLVE_MAX_GAP_HOURS` (default 4 h ≈ eight consecutive missed runs, well past any deploy or reboot window). This read is the reason (b) is worth having at all — a heartbeat nothing consumes is not a signal — and it is emphatically _not_ a query predicate. It is a **backstop** to (a), not a replacement: it can only fire once the job runs again, whereas a missed check-in fires while the job is still down.

**(c) Drain check.** After a real run, a pass that saw candidates but wrote fewer rows than it saw gets a warning. `library.legacy_release_id` carries a unique index, so a pass's `COUNT(*)` over the join counts exactly the distinct rows its UPDATE targets — `resolved < candidates` cannot happen benignly. (`resolved > candidates` can and is fine: `library-etl` shares the half-hourly slot, so a matching `library` row can land between the COUNT and the UPDATE.) A zero-candidate run never alerts.

There is deliberately **no cohort-age detector**. It would be the natural shape for (c), but `library.add_date` and `library.last_modified` are legacy-sourced — `jobs/library-etl/job.ts` writes them from tubafrenzy's `release_time_created` / `release_last_modified`, not `now()` — so no column records when a `library` row became visible to Backend. An age computed from them measures the librarian's filing date, not repair latency, and a catalog gap-fill importing a 1998 release today would report a 27-year-old "candidate" on a perfectly healthy run.

This is the fleet's first Sentry cron monitor; the recipe generalizes to the other crons in `jobs/` and is recorded in [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md#cron-liveness-bs2064). BS#1201 proposes the CloudWatch-side version (a heartbeat metric emitted by the cron _wrapper_, which also catches a container that never starts); the two are complementary, and nothing here forecloses it.
