# apple-music-url-backfill

One-shot remediation for BS#1631. Re-queries LML for every `album_metadata` / `flowsheet` row where `apple_music_url IS NULL` despite a positive match signal, and fills ONLY the still-null rows. **Dry-run is the default; writes require `--execute`.**

## Problem

Backend-Service persists LML's `apple_music_url` verbatim, including the null LML returns on a first lookup when (a) LML's 4s synchronous Apple track-probe timed out — expected under the daily 06:00 UTC `flowsheet-metadata-backfill` flood — or (b) the Apple album URL was only reachable via LML's _eventually-consistent_ streaming post-process (LML#706), which returns null on the first lookup and warms its cache in the background. BS never re-queries, and BS#1192 deliberately synthesizes no Apple fallback, so a transient / first-lookup null became **permanent**. The 2026-07-13 audit found 21 null rows in the 60 most-recent flowsheet entries, ~14 demonstrably on Apple Music (e.g. Daft Punk – _Discovery_, an `enriched_match` row with a real `discogs_url`).

**Candidate predicate** (identical in the job's phase-start COUNT, its batch SELECT, and the scope-confirm SQL below): `apple_music_url IS NULL` AND (`discogs_url IS NOT NULL` OR linked `library.on_streaming = true`) — re-check likely-present albums, not the genuine-absence long tail.

```sql
-- Confirm scope BEFORE running (org data-safety rule). Same predicates the job uses.
SELECT COUNT(*) FROM wxyc_schema.album_metadata am
JOIN wxyc_schema.library l ON l.id = am.album_id
LEFT JOIN wxyc_schema.artists a ON l.artist_id = a.id
WHERE am.apple_music_url IS NULL
  AND (am.discogs_url IS NOT NULL OR l.on_streaming = true)
  AND COALESCE(a.artist_name, l.artist_name) IS NOT NULL;

SELECT COUNT(*) FROM wxyc_schema.flowsheet f
LEFT JOIN wxyc_schema.library l ON l.id = f.album_id
WHERE f.entry_type = 'track'
  AND f.apple_music_url IS NULL
  AND (f.discogs_url IS NOT NULL OR l.on_streaming = true)
  AND f.artist_name IS NOT NULL;
```

Per candidate the job runs up to TWO LML lookups (artist + album + song, `extended: true`): the second fires only when the first returned no Apple URL, after `BACKFILL_SECOND_PASS_DELAY_MS`, to catch LML#706's eventual-consistency fill. Repeat (artist, album, track) triples are served from an in-run cache — the track component is load-bearing because LML's `apple_music_url` can be a per-track `/song/<id>` URL (BS#1192).

## Pre-flight checklist

1. **LML#782 deployed to LML production** (the gate on this whole ticket — without it the re-query just re-persists nulls). Verify the LML prod deploy includes the #786 fix before `--execute`; a dry-run's `would_resolve` count doubling as a live probe is the cheap way to confirm.

2. **Sibling cron is stopped.** All backfill jobs share the `BACKFILL_LML_*` token bucket AND LML's 50/min global Discogs ceiling. Concurrent runs trip the BS#994 outage pattern.

   ```bash
   docker ps -a --filter name=flowsheet-metadata-backfill-cron --format '{{.Status}}'
   # Must show: Exited (any exit code is fine — running is not)
   ```

3. **Run off-peak, outside the 06:00 UTC window** — that flood is the very condition that produced the nulls (coordinate with BS#1591). The cooperative pause defers batches while DJs are active, but scheduling around the flood is still on the operator.

4. **Optional but recommended for the flowsheet phase: build the partial index out-of-band.** The flowsheet WHERE has no covering index; without one, each batch SELECT degrades toward a heap scan as the cursor advances. The predicate below is a superset of both OR arms (the planner walks it in `id` order and filters the OR per fetched row):

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS flowsheet_apple_null_backfill_idx
     ON wxyc_schema.flowsheet (id)
     WHERE entry_type = 'track' AND apple_music_url IS NULL AND artist_name IS NOT NULL;
   ```

   `CONCURRENTLY` takes only a `ShareUpdateExclusiveLock`, so DJs keep inserting while it builds. Drop it after the run (see Post-run). `album_metadata` (~tens of k rows) needs no index.

5. **Snapshot the non-null rows** so the post-run never-overwrite spot-check is a mechanical diff:

   ```sql
   CREATE TABLE wxyc_schema.apple_backfill_prerun_fs AS
     SELECT id, apple_music_url FROM wxyc_schema.flowsheet WHERE apple_music_url IS NOT NULL;
   CREATE TABLE wxyc_schema.apple_backfill_prerun_am AS
     SELECT album_id, apple_music_url FROM wxyc_schema.album_metadata WHERE apple_music_url IS NOT NULL;
   ```

## Run procedure

```bash
# 1. Build & push image
gh workflow run deploy-manual.yml --ref main \
  -f target=apple-music-url-backfill -f version=latest

# 2. SSH to EC2. Tee logs to a file BEFORE relying on `docker logs` —
# `--rm` removes the container on exit and the structured summary line
# is unrecoverable afterwards. `--name` is load-bearing for the
# kill-switch below.
ssh wxyc-ec2

# 3. DRY-RUN FIRST (the default — no flag needed). Full paced LML sweep,
# candidate + would-change counts, ZERO writes.
docker run --rm --name apple-music-url-backfill --env-file .env \
  <ECR-URI>/apple-music-url-backfill:<tag> 2>&1 \
  | tee /tmp/apple-music-url-backfill-dryrun-$(date +%Y%m%d-%H%M%S).log

# 4. Review the dry-run summary (see Post-run jq), then execute:
docker run --rm --name apple-music-url-backfill --env-file .env \
  <ECR-URI>/apple-music-url-backfill:<tag> --execute 2>&1 \
  | tee /tmp/apple-music-url-backfill-$(date +%Y%m%d-%H%M%S).log
```

For a bounded pilot, add `-e BACKFILL_MAX_ROWS_PER_TABLE=50`.

> **Env-var read timing**: `lml-fetch.ts` reads `BACKFILL_LML_PER_CALL_TIMEOUT_MS` and `lml-limiter.ts` reads `BACKFILL_LML_MAX_CONCURRENT` / `BACKFILL_LML_RATE_PER_MIN` at module load. Pass env vars via `--env-file`/`-e` so they're visible to PID 1; exporting inside the container after start is silently ignored.

## Pacing & wall-clock estimate

Serial rows behind Sem(1) + TB(20/min). A first-pass hit costs 1 token; an unresolved candidate costs 2 tokens + the 15 s second-pass delay, so throughput ranges ~7–20 candidates/min depending on hit rate (LML lookups can take up to ~15 s each on top). Size the run from the dry-run's candidate counts before `--execute`.

## Kill-switch

```bash
# Up to 10 min of grace so the in-flight row drains, the structured
# `stopped` line (with resume cursors) is emitted, Sentry flushes, and
# the DB pool closes. Docker's default 10 s grace would SIGKILL first.
docker stop -t 600 apple-music-url-backfill
```

The SIGTERM handler flips a cooperative-stop flag checked between rows (and inside every sleep), so a single in-flight LML lookup is the longest wait. Repeated SIGTERM/SIGINT are idempotent; the escape hatch for a wedged LML call is `docker kill` (SIGKILL — skips the `finally` arm, so Sentry may lose the last seconds).

## Resumability & idempotency

- Resolved rows drop out of the WHERE (`apple_music_url IS NULL`), so plain re-runs are always safe and only re-visit still-null rows.
- To skip already-swept still-null rows after a `stopped`/`failed` run, pass the summary line's per-phase `last_id` cursors: `-e BACKFILL_ALBUM_AFTER_ID=<n> -e BACKFILL_FLOWSHEET_AFTER_ID=<n>`.
- Never-overwrite is enforced in the UPDATE's WHERE (`... AND apple_music_url IS NULL`), not just app logic — a URL that appears mid-run makes the UPDATE match 0 rows (counted `skipped_non_null`).

## Post-run

1. **Source the counts** from the `finished` / `stopped` / `failed` summary line (`-R` + `fromjson?` skips the non-JSON env-validation warns):

   ```bash
   cat /tmp/apple-music-url-backfill-*.log | \
     jq -rR 'fromjson? | select(.step=="finished" or .step=="stopped" or .step=="failed") |
       "step=\(.step) dry_run=\(.dry_run) " +
       "am: candidates=\(.album_metadata.candidates) resolved=\(.album_metadata.resolved) would=\(.album_metadata.would_resolve) still_null=\(.album_metadata.still_null) skipped=\(.album_metadata.skipped_non_null) lml_err=\(.album_metadata.lml_error) last_id=\(.album_metadata.last_id) | " +
       "fs: candidates=\(.flowsheet.candidates) resolved=\(.flowsheet.resolved) would=\(.flowsheet.would_resolve) still_null=\(.flowsheet.still_null) skipped=\(.flowsheet.skipped_non_null) lml_err=\(.flowsheet.lml_error) last_id=\(.flowsheet.last_id)"'
   ```

   Document the totals as a comment on BS#1631.

2. **Never-overwrite spot-check** (acceptance criterion): diff against the pre-run snapshot — both counts must be 0, then drop the snapshot tables.

   ```sql
   SELECT COUNT(*) FROM wxyc_schema.apple_backfill_prerun_fs s
   JOIN wxyc_schema.flowsheet f USING (id)
   WHERE f.apple_music_url IS DISTINCT FROM s.apple_music_url;

   SELECT COUNT(*) FROM wxyc_schema.apple_backfill_prerun_am s
   JOIN wxyc_schema.album_metadata a USING (album_id)
   WHERE a.apple_music_url IS DISTINCT FROM s.apple_music_url;

   DROP TABLE wxyc_schema.apple_backfill_prerun_fs, wxyc_schema.apple_backfill_prerun_am;
   ```

3. **Audit-cohort check** (acceptance criterion): confirm the ~14 present-on-Apple rows from the 2026-07-13 audit (incl. Daft Punk – _Discovery_) now carry a non-null `apple_music_url`.

4. **Drop the one-shot index**:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS wxyc_schema.flowsheet_apple_null_backfill_idx;
   ```

## Environment variables

| Variable                           | Default    | Notes                                                               |
| ---------------------------------- | ---------- | ------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`             | (required) | LML endpoint                                                        |
| `BACKFILL_BATCH_SIZE`              | 100        | Rows per SELECT                                                     |
| `BACKFILL_MAX_ROWS_PER_TABLE`      | 0          | 0 = unlimited; positive cap bounds a pilot run per phase            |
| `BACKFILL_SECOND_PASS_DELAY_MS`    | 15000      | Delay before the second lookup (LML#706 fill window); 0 = immediate |
| `BACKFILL_ALBUM_AFTER_ID`          | 0          | Resume cursor for the album_metadata phase                          |
| `BACKFILL_FLOWSHEET_AFTER_ID`      | 0          | Resume cursor for the flowsheet phase                               |
| `BACKFILL_LML_MAX_CONCURRENT`      | 1          | Semaphore permit count (shared knob across the backfill family)     |
| `BACKFILL_LML_RATE_PER_MIN`        | 20         | Token bucket rate                                                   |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS` | 35000      | Per-LML-call timeout (ms)                                           |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`   | 60         | Set 0 to disable the cooperative pause                              |
| `LIVE_ACTIVITY_PAUSE_MS`           | 30000      | Pause duration when DJ activity detected (ms)                       |
| `SENTRY_DSN`                       | (optional) | Sentry error reporting                                              |

CLI flags: `--execute` (write mode), `--dry-run` (explicit no-op, the default; passing both fails fast).
