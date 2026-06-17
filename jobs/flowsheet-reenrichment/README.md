# flowsheet-reenrichment

One-shot re-enrichment drain for BS#1433. Rescues ~11,965 `flowsheet` rows written as `enriched_no_match` before LML#583 (merged 2026-06-16T17:53:53Z) closed the library-miss recall gap.

## Problem

Before LML#583, `(artist, album)` pairs not in the WXYC library returned `results: []` from LML, causing `metadata_status='enriched_no_match'` to be written. Those rows are terminal in the new enum — the CDC consumer never revisits them. With LML#583 live, the same pairs now return Discogs metadata; this job performs a single sweep to recover them.

**Target cohort** (verified on prod 2026-06-16, 11,965 rows):

```sql
SELECT COUNT(*) FROM wxyc_schema.flowsheet
WHERE metadata_status = 'enriched_no_match'
  AND album_id IS NULL
  AND artist_name IS NOT NULL;
```

## Pre-flight checklist

1. **LML#583 deployed**: PR #584 merged 2026-06-16T17:53:53Z; Railway auto-deploys on main push. Verify at Railway dashboard.

2. **Sibling cron is stopped**: Both jobs share the `BACKFILL_LML_*` token bucket and LML's 50/min global ceiling. Concurrent runs trip the BS#994 outage pattern.

   ```bash
   docker ps -a --filter name=flowsheet-metadata-backfill-cron --format '{{.Status}}'
   # Must show: Exited (any exit code is fine — running is not)
   ```

   If `docker ps -a` shows `Up …`, coordinate with #1011's resume sequence before launching.

3. **Build the partial index out-of-band** (avoids the AccessExclusiveLock that an in-migration DDL would take on the 2.6M-row `flowsheet` table). The cohort's WHERE has no covering index in the current schema — without this, each batch SELECT degrades to a heap scan as the cursor advances, multiplying wall-clock by orders of magnitude:

   ```sql
   -- ssh to the host that can reach prod RDS, then psql:
   CREATE INDEX CONCURRENTLY IF NOT EXISTS flowsheet_reenrichment_idx
     ON wxyc_schema.flowsheet (id)
     WHERE metadata_status = 'enriched_no_match'
       AND album_id IS NULL
       AND artist_name IS NOT NULL;
   ```

   `CONCURRENTLY` takes only a `ShareUpdateExclusiveLock`, so DJs continue inserting while the index builds (typically < 30 s for a partial covering ~12k of 2.6M rows). The index is one-shot — drop it after the run (see "Post-run").

4. **Run the pre-launch diagnostic** to understand the cohort partition:
   ```sql
   SELECT
     CASE WHEN metadata_attempt_at IS NULL THEN 'null' ELSE 'populated' END AS bucket,
     COUNT(*),
     MIN(add_time) AS earliest_add_time,
     MAX(add_time) AS latest_add_time
   FROM wxyc_schema.flowsheet
   WHERE metadata_status = 'enriched_no_match'
     AND album_id IS NULL AND artist_name IS NOT NULL
   GROUP BY 1;
   ```

## Run procedure

```bash
# 1. Build & push image
gh workflow run deploy-manual.yml --ref main \
  -f target=flowsheet-reenrichment -f version=latest

# 2. SSH to EC2 and run. `--name` is load-bearing — the kill-switch below
# greps it; without it docker assigns a random name and `docker stop` fails.
ssh wxyc-ec2
docker run --rm --name flowsheet-reenrichment --env-file .env \
  -e BACKFILL_CUTOFF_TS='2026-06-16T17:53:53Z' \
  <ECR-URI>/flowsheet-reenrichment:<tag>
```

## Pacing & wall-clock estimate

- Sem(1) + TB(20/min): ~12k rows ÷ 20/min ≈ ~10 hours raw rate
- With cooperative-pause deferral during DJ activity (most of every 24h at WXYC): ~12-15 hours realistic

## Kill-switch

```bash
docker stop flowsheet-reenrichment
```

The container's SIGTERM handler flips a cooperative-stop flag; the run finishes its in-flight row, emits a `stop_requested` log line, and exits cleanly so Sentry flushes and the DB pool closes. Monitor real-time LML p95 via Sentry trace explorer; stay within +20% of baseline per the BS#994 acceptance criterion.

## Post-run

1. **Source the flip count** from the `finished` log line:

   ```bash
   docker logs flowsheet-reenrichment 2>&1 | \
     jq -r 'select(.step=="finished") |
       "scanned=\(.scanned) flipped=\(.flipped) match_raced=\(.match_raced) still_no_match=\(.still_no_match) lml_error=\(.lml_error) db_error=\(.db_error)"'
   ```

   Document these as a comment on BS#1433.

2. **Linkage-race audit**: a parallel linkage resolver can flip `album_id` non-null between the orchestrator's SELECT and `reenrichRow`'s UPDATE, which the WHERE guard then skips (counted as `match_raced`). Most `match_raced` rows are benign (another writer flipped the status), but the rare orphan case leaves a row with `album_id` non-null AND `metadata_status='enriched_no_match'` — no automated path revisits these. Catch them with:

   ```sql
   SELECT id, album_id, artist_name, album_title, add_time
   FROM wxyc_schema.flowsheet
   WHERE metadata_status = 'enriched_no_match'
     AND album_id IS NOT NULL
     AND add_time < '2026-06-16T17:53:53Z'::timestamptz;
   ```

   For each orphan row, manually trigger re-enrichment (e.g. via the CDC consumer by setting `metadata_status='pending'`) or open a follow-up ticket if the count is non-trivial. Cross-reference the `possible_linkage_race` log lines from the run (each `match_raced` row id is emitted as a structured warning).

3. **Spot-check 20 sample rows that flipped** — verify `discogs_url`, `artwork_url`, `release_year` populated and correct against the live Discogs release.

4. **Drop the one-shot index** once the audit is complete:
   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS wxyc_schema.flowsheet_reenrichment_idx;
   ```

## Environment variables

| Variable                           | Default    | Notes                                                                                              |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `BACKFILL_CUTOFF_TS`               | (required) | LML#583 merge timestamp: `2026-06-16T17:53:53Z`. Validated as ISO 8601 + not-in-future at startup. |
| `LIBRARY_METADATA_URL`             | (required) | LML endpoint                                                                                       |
| `BACKFILL_BATCH_SIZE`              | 100        | Rows per SELECT                                                                                    |
| `BACKFILL_LML_MAX_CONCURRENT`      | 1          | Semaphore permit count (positive integer)                                                          |
| `BACKFILL_LML_RATE_PER_MIN`        | 20         | Token bucket rate (positive integer)                                                               |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS` | 35000      | Per-LML-call timeout (ms)                                                                          |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`   | 60         | Set 0 to disable cooperative pause                                                                 |
| `LIVE_ACTIVITY_PAUSE_MS`           | 30000      | Pause duration when DJ activity detected (ms)                                                      |
| `SENTRY_DSN`                       | (optional) | Sentry error reporting                                                                             |
