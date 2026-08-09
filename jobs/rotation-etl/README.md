# rotation-etl

Imports `rotation` rows from tubafrenzy MySQL (`ROTATION_RELEASE` joined with `COMPANY`) into Backend-Service PostgreSQL.

## Status: retained, unscheduled, refuses by default

Phase 3 of the tubafrenzy decommission ([WXYC/wiki#88](https://github.com/WXYC/wiki/issues/88)) flipped `rotation` to **Backend-canonical**. This job's `package.json` carries `"job-type": "one-shot"`, so the deploy builds and pushes the image to ECR but does not register a crontab entry. The code is retained deliberately — the decommission plan's Phase 3 step 3 says "leave the code for now" — so it stays invocable during the Phase 6a maintenance window.

It **refuses to run** unless `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1` is set. Read the rest of this file before setting it.

> **Removing the `job-type` line re-arms a live half-hourly cron against tubafrenzy.** There is no other signal. The `cron-schedule` key was deleted for the same reason.

## Why running it is a backwards write — and how it differs from the flowsheet sibling

**Do not reason by analogy with `flowsheet-etl`.** There is no rotation mirror: `legacy_rotation_id` is written only by `/internal/rotation-webhook`, never back-stamped onto a dj-site-originated row (`rotation-match.mirror.ts` is the rotation-badge probe, not a writer). So unlike the flowsheet job, this one **cannot reach a pure dj-site row**.

What it does reach is **every row that ever came from tubafrenzy**. For those, the upsert on `rotation.legacy_rotation_id` overwrites:

- `rotation_bin`, `kill_date`, `album_id`
- the denormalized `artist_name` / `album_title` / `record_label`

Once the music director manages rotation in dj-site, a Backend-side edit to such a row is silently reverted to whatever tubafrenzy still holds.

Two further hazards, both live even for a single deliberate run:

- **Provenance restamp.** `discogs_release_id_source` flips to `tubafrenzy_paste` on any row where tubafrenzy contributes a non-NULL id, overwriting a value `jobs/rotation-release-id-backfill` may have written since. The `COALESCE` + `CASE` shape exists to protect the _id_ ([BS#1029](https://github.com/WXYC/Backend-Service/issues/1029)); it does not protect the source column from a legitimate-looking tubafrenzy value.
- **Frozen watermark** — see below.

## The frozen watermark

`runIncremental` starts from `getLastRunTimestamp('rotation-etl')` (`wxyc_schema.cronjob_runs`) and only calls `updateLastRun` at the end. That watermark stopped advancing when the cron stopped, so a run months later replays the entire accumulated delta through a per-row awaited upsert loop.

Bound the window before running:

```sql
-- Inspect first.
SELECT job_name, last_run FROM wxyc_schema.cronjob_runs WHERE job_name = 'rotation-etl';

-- Then move the watermark forward to the window you actually intend to replay.
UPDATE wxyc_schema.cronjob_runs SET last_run = '<intended start>' WHERE job_name = 'rotation-etl';
```

## You probably want a different job

The `album_id` linkage repair this job used to perform as a tail pass — the only part that was never a backwards write — now lives in **[`jobs/legacy-linkage-resolve/`](../legacy-linkage-resolve/README.md)** and runs every 30 minutes. It also clears the denormalized `artist_name` / `album_title` / `record_label` once a row links, exactly as the tail pass did.

If you are here because rotation rows are missing their `album_id` — the NULL tail that feeds the rotation-badge JOIN and the `rotation.discogs_release_id` backfill — that is the job to look at, and it needs no override.

## If you genuinely intend the import

```bash
LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1 node dist/job.js
```

Bound the watermark first (above), and expect it to revert Backend-side edits on every tubafrenzy-originated row it touches.
