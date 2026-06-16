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
   # Must show: Exited (1)
   ```
   If not exited, coordinate with #1011's resume sequence before launching.

3. **Run the pre-launch diagnostic** to understand the cohort partition:
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

# 2. SSH to EC2 and run
ssh wxyc-ec2
docker run --rm --env-file .env \
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

Monitor real-time LML p95 via Sentry trace explorer; stay within +20% of baseline per the BS#994 acceptance criterion.

## Post-run

Source the flip count from the `finished` log line's `flipped` field:
```bash
docker logs <container> 2>&1 | jq -r 'select(.step=="finished") | "flipped=\(.flipped) still_no_match=\(.still_no_match) lml_error=\(.lml_error)"'
```

Document the count as a comment on BS#1433.

Then spot-check 20 sample rows that flipped — verify `discogs_url`, `artwork_url`, `release_year` populated and correct.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `BACKFILL_CUTOFF_TS` | (required) | LML#583 merge timestamp: `2026-06-16T17:53:53Z` |
| `LIBRARY_METADATA_URL` | (required) | LML endpoint |
| `BACKFILL_BATCH_SIZE` | 100 | Rows per SELECT |
| `BACKFILL_LML_MAX_CONCURRENT` | 1 | Semaphore permit count |
| `BACKFILL_LML_RATE_PER_MIN` | 20 | Token bucket rate |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS` | 35000 | Per-LML-call timeout (ms) |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS` | 60 | Set 0 to disable cooperative pause |
| `LIVE_ACTIVITY_PAUSE_MS` | 30000 | Pause duration when DJ activity detected |
| `SENTRY_DSN` | (optional) | Sentry error reporting |
