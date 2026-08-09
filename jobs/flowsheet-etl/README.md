# flowsheet-etl

Imports `shows` and `flowsheet` rows from tubafrenzy MySQL into Backend-Service PostgreSQL.

## Status: retained, unscheduled, refuses by default

Phase 3 of the tubafrenzy decommission ([WXYC/wiki#88](https://github.com/WXYC/wiki/issues/88)) flipped `shows` and `flowsheet` to **Backend-canonical**. This job's `package.json` carries `"job-type": "one-shot"`, so the deploy builds and pushes the image to ECR but does not register a crontab entry. The code is retained deliberately — the decommission plan's Phase 3 step 3 says "leave the code for now" — so it stays invocable during the Phase 6a maintenance window.

It **refuses to run** unless `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1` is set. Read the rest of this file before setting it.

> **Removing the `job-type` line re-arms a live half-hourly cron against tubafrenzy.** There is no other signal. The `cron-schedule` key was deleted for the same reason.

## Why running it is a backwards write

The upserts key on columns the **live mirror back-stamps onto dj-site-originated rows**:

| Upsert    | Conflict target             | Overwrites                                                                       |
| --------- | --------------------------- | -------------------------------------------------------------------------------- |
| shows     | `shows.legacy_show_id`      | `start_time`, `end_time`, `show_name`, `legacy_dj_name`, `legacy_dj_id`          |
| flowsheet | `flowsheet.legacy_entry_id` | `play_order`, `add_time`, `show_id`, `artist_name`, `album_title`, `track_title` |

`startShow` in `apps/backend/middleware/legacy/flowsheet.mirror.ts` persists `legacy_show_id` after `mirrorCreateShow` succeeds, and the entry mirror does the same for `legacy_entry_id`. So a mirrored dj-site show **exists in tubafrenzy**, is returned by `fetchLegacyShows`, and has its Backend-canonical values replaced by tubafrenzy's mirror copy.

Under the old regime tubafrenzy was authoritative and that overwrite was the whole point. After the SOURCE flip it round-trips Backend's own data through a mirror and lets the copy win.

The shows UPSERT comment still reads "tubafrenzy is the source of truth for show metadata via this UPSERT" (BS#1084). That was true when the job was scheduled. It is now the precise statement the guard exists to stop you acting on.

## The frozen watermark

`runIncremental` starts from `getLastRunTimestamp('flowsheet-etl')` (`wxyc_schema.cronjob_runs`) and only calls `updateLastRun` at the end. That watermark stopped advancing when the cron stopped.

A run months later therefore replays the **entire accumulated delta** through a per-row awaited upsert loop, followed by a full-table `resolveAlbumIds()` UPDATE. That is the shape of the [#511](https://github.com/WXYC/Backend-Service/issues/511) wedge: when the cron's `docker rm -f` killed the container, the orphaned PostgreSQL backend kept holding row locks and blocked the next tick.

Bound the window before running:

```sql
-- Inspect first.
SELECT job_name, last_run FROM wxyc_schema.cronjob_runs WHERE job_name = 'flowsheet-etl';

-- Then move the watermark forward to the window you actually intend to replay.
UPDATE wxyc_schema.cronjob_runs SET last_run = '<intended start>' WHERE job_name = 'flowsheet-etl';
```

## You probably want a different job

The `album_id` linkage repair this job used to perform as a tail pass — the only part that was never a backwards write — now lives in **[`jobs/legacy-linkage-resolve/`](../legacy-linkage-resolve/README.md)** and runs every 30 minutes. If you are here because flowsheet rows are missing their `album_id`, that is the job to look at, and it needs no override.

## If you genuinely intend the import

```bash
LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1 node dist/job.js              # incremental
LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1 node dist/job.js dump.sql     # bulk load
LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1 node dist/job.js dump.sql --replace
```

Bound the watermark first (above), and expect it to revert Backend-side edits on every mirrored row it touches.
