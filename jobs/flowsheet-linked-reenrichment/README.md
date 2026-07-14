# flowsheet-linked-reenrichment (BS#1638)

One-shot re-enrichment of the BS#1443 `enriched_no_match` **linked** cohort — the 22,773 flowsheet rows stuck at terminal `metadata_status='enriched_no_match'` with `album_id IS NOT NULL`. No automated path revisits this population (the CDC consumer fires on INSERT only, the sweep targets `enriching`, and the metadata-backfill cron keys on `metadata_attempt_at IS NULL`), so it needs a one-shot drain.

This is the rescue the sibling `jobs/flowsheet-reenrichment` README (BS#1433) names for its "match_raced orphans" — but as the automated Option-1 path BS#1443 chose, **not** the manual `SET metadata_status='pending', metadata_attempt_at=NULL` cron re-arm (Option 2, rejected because it would perturb BS#1011's drain-completion signal and BS#895's C6 retune).

## Frozen cohort predicate

Applied in full to every SELECT and every UPDATE (re-verified live 2026-07-13, exactly 22,773 rows):

```sql
metadata_status = 'enriched_no_match'
AND album_id IS NOT NULL
AND artist_name IS NOT NULL
AND add_time < '2026-06-16T17:53:53Z'::timestamptz
```

No `entry_type='track'` narrow — BS#1443's audit froze the count at exactly these four clauses; a fifth risks stranding a non-track cohort row forever.

## Two lanes

- **Lane A (pure SQL, zero LML calls)** — cohort rows whose `album_id` already has a _populated_ `album_metadata` row (`discogs_url IS NOT NULL OR artwork_url IS NOT NULL`) flip to `enriched_match`. ~15,231 rows / 523 albums. Batched (`LINKED_REENRICH_FLIP_BATCH_SIZE`, default 5000) with `ANALYZE flowsheet` after, per [`docs/bulk-update-playbook.md`](../../docs/bulk-update-playbook.md).
- **Lane B (LML re-lookup)** — the ~314 residual albums (308 both-null in `album_metadata` + 6 absent). Batch through `bulkLookupMetadata` (LML#368, post-LML#784 recall fixes). On match: **fill-null** UPSERT into `album_metadata` (never clobber a populated field) then flip that album's cohort rows. On no-match: leave the rows — post-#784 that is a verified verdict.

`metadata_attempt_at` is never written and `metadata_status='pending'` is never set, so BS#1011 / BS#895 are untouched.

## Run procedure

Runs via `deploy-manual.yml` (target=`flowsheet-linked-reenrichment`, version=`latest`), then SSH to EC2. **Dry-run is the default**; `--execute` writes.

### 1. Pre-flight: build the partial index out-of-band

The cohort predicate has no covering index in the current schema (`0078`/`0070` cover `pending`/`enriching`; `0081` is a functional partial on `album_id IS NOT NULL`). Without this, each Lane A flip batch and the residual enumeration degrade to heap scans on the 2.6M-row `flowsheet`. Build it `CONCURRENTLY` (only a `ShareUpdateExclusiveLock`, so DJs keep inserting), mirroring the sibling job:

```sql
-- ssh to the host that can reach prod RDS, then psql:
CREATE INDEX CONCURRENTLY IF NOT EXISTS flowsheet_linked_reenrichment_idx
  ON wxyc_schema.flowsheet (id)
  WHERE metadata_status = 'enriched_no_match'
    AND album_id IS NOT NULL
    AND artist_name IS NOT NULL;
```

### 2. Pre-flight: confirm no sibling cron is mid-run

The 06:00 UTC `flowsheet-metadata-backfill` cron and this job both call LML. Don't run them together (`docker ps -a`).

### 3. Dry-run, then execute

```bash
docker run --rm --name flowsheet-linked-reenrichment --env-file .env \
  <ECR-URI>/flowsheet-linked-reenrichment:<tag>              # dry-run (default)
docker run --rm --name flowsheet-linked-reenrichment --env-file .env \
  <ECR-URI>/flowsheet-linked-reenrichment:<tag> --execute    # writes
```

Run off-peak. Dry-run performs the Lane A scope count + Lane B residual enumeration and logs the planned batch count with **zero** LML calls and zero writes.

### 4. Post-run verification (comment on BS#1443)

Post the final counters (`flipped_from_album_metadata`, `lml_match`, `lml_no_match`, `lml_error`, `db_error`) from the `finished` log line, then re-count the cohort:

```sql
SELECT count(*) FROM wxyc_schema.flowsheet
WHERE metadata_status = 'enriched_no_match'
  AND album_id IS NOT NULL
  AND artist_name IS NOT NULL
  AND add_time < '2026-06-16T17:53:53Z'::timestamptz;
-- Expected residual = lml_no_match albums' rows (verified terminal verdicts).
```

### 5. Post-run: drop the one-shot index

```sql
DROP INDEX CONCURRENTLY IF EXISTS wxyc_schema.flowsheet_linked_reenrichment_idx;
```

## Idempotency & resume

- Re-running is a no-op on already-flipped rows (they leave the `enriched_no_match` predicate), matched albums (they leave the residual set), and the fill-null UPSERT (guarded by `updated_at < NOW()`).
- Lane A's flip is self-resuming (flipped rows drop out; no cursor needed).
- Lane B resumes via `LINKED_REENRICH_ALBUM_AFTER_ID` — set it to the summary log's `last_album_id` from a stopped run.

## Environment variables

| Var                                 | Default  | Purpose                                                      |
| ----------------------------------- | -------- | ------------------------------------------------------------ |
| `LINKED_REENRICH_BULK_BATCH_SIZE`   | `5`      | Items per Lane B bulk-lookup request (LML cap 100).          |
| `LINKED_REENRICH_BULK_RATE_PER_MIN` | `1`      | Lane B batches per minute.                                   |
| `LINKED_REENRICH_BULK_BUDGET_MS`    | `25000`  | Per-item LML `X-Caller-Budget-Ms`.                           |
| `LINKED_REENRICH_FLIP_BATCH_SIZE`   | `5000`   | Rows per flip UPDATE transaction.                            |
| `LINKED_REENRICH_FLIP_TIMEOUT_MS`   | `300000` | Statement timeout per flip batch.                            |
| `LINKED_REENRICH_READ_TIMEOUT_MS`   | `300000` | Statement timeout for count/enumerate/resolve SELECTs.       |
| `LINKED_REENRICH_ALBUM_AFTER_ID`    | `0`      | Lane B resume cursor.                                        |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`    | `300`    | Cooperative-pause lookback; `0` disables.                    |
| `LIBRARY_METADATA_URL`              | —        | LML base URL. Required for `--execute` (Lane B).             |
| `DB_*`, `SENTRY_*`                  | —        | Standard DB + observability config (see `docs/env-vars.md`). |

## References

- BS#1638 — this job. BS#1443 — parent decision ticket (Option 1 chosen).
- BS#1041 (`jobs/album-level-backfill`) — structural donor (distinct-album enrich + paired row flip).
- BS#1433 (`jobs/flowsheet-reenrichment`) — unlinked-cohort drain; documented this cohort as its orphan-rescue target.
- LML#784 — recall-gap fix (merged, deployed); the reason re-enrichment is worth running now.
- BS#1011 / BS#895 — cron retirement + C6 retune; deliberately untouched by this job.
