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

## Schedule

`*/30 * * * *` UTC, from `package.json`'s `cron-schedule` — the same cadence the repair had inside the ETLs, and the same cadence as `library-etl`, which is what produces the library rows this job waits on. DB-only: no `@wxyc/lml-client` dependency, so it is exempt from the LML cron-spacing policy in [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md).

## Design notes

**No cooperative live-DJ pause.** The candidate set is bounded by the rows a webhook could not link and the writes are narrow. Deferring the repair indefinitely through a long show is worse than the contention it would avoid. This matches the behaviour the pass had inside the ETLs, which never paused either.

**No watermark.** Unlike the ETLs it was extracted from, this job holds no `cronjob_runs` entry. Both statements are set-based over the current NULL cohort, so there is no delta to track and no watermark to go stale between runs.
