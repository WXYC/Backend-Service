# flowsheet-linked-reenrichment (BS#1638)

One-shot re-enrichment of the BS#1443 `enriched_no_match` **linked** cohort — the 22,773 flowsheet rows stuck at terminal `metadata_status='enriched_no_match'` with `album_id IS NOT NULL`. No automated path revisits this population (the CDC consumer fires on INSERT only, the sweep targets `enriching`, and the metadata-backfill cron keys on `metadata_attempt_at IS NULL`), so it needs a one-shot drain.

This is the rescue the sibling `jobs/flowsheet-reenrichment` README (BS#1433) names for its "match_raced orphans" — but as the automated Option-1 path BS#1443 chose, **not** the manual `SET metadata_status='pending', metadata_attempt_at=NULL` cron re-arm (Option 2, rejected because it would perturb BS#1011's drain-completion signal and BS#895's C6 retune).

## Shipping in two chained PRs

The job has two lanes with a shared cohort predicate and flip machinery. They ship separately so the rollout is staged:

- **Lane A (this PR)** — pure SQL, zero LML. Drains the ~15,231 rows / 523 albums whose album already has populated metadata. No external dependency, so it can be verified in production before Lane B exists.
- **Lane B (chained follow-up PR)** — the ~314 residual albums (308 both-null in `album_metadata` + 6 absent) via LML `bulkLookupMetadata` with a fill-null `album_metadata` UPSERT, then a paired flip. Reuses this file's cohort predicate + `flipPopulatedCohort`.

## Frozen cohort predicate

Applied in full to every SELECT and every UPDATE (re-verified live 2026-07-13, exactly 22,773 rows):

```sql
metadata_status = 'enriched_no_match'
AND album_id IS NOT NULL
AND artist_name IS NOT NULL
AND add_time < '2026-06-16T17:53:53Z'::timestamptz
```

No `entry_type='track'` narrow — BS#1443's audit froze the count at exactly these four clauses; a fifth risks stranding a non-track cohort row forever.

## Lane A behavior

Cohort rows whose `album_id` already has a _populated_ `album_metadata` row (`discogs_url IS NOT NULL OR artwork_url IS NOT NULL`) flip to `enriched_match`. Batched (`LINKED_REENRICH_FLIP_BATCH_SIZE`, default 5000) with `ANALYZE flowsheet` after, per [`docs/bulk-update-playbook.md`](../../docs/bulk-update-playbook.md). The flip `SET`s the literal `enriched_match` (never a COALESCE), so flipped rows leave the predicate and each batch self-advances to the next-lowest ids — no offset cursor.

`metadata_attempt_at` is never written and `metadata_status='pending'` is never set, so BS#1011 / BS#895 are untouched.

## Run procedure

Runs via `deploy-manual.yml` (target=`flowsheet-linked-reenrichment`, version=`latest`), then SSH to EC2. **Dry-run is the default**; `--execute` writes.

### 1. Pre-flight: build the partial index out-of-band

The cohort predicate has no covering index in the current schema (`0078`/`0070` cover `pending`/`enriching`; `0081` is a functional partial on `album_id IS NOT NULL`). Without this, each Lane A flip batch degrades to a heap scan on the 2.6M-row `flowsheet`. Build it `CONCURRENTLY` (only a `ShareUpdateExclusiveLock`, so DJs keep inserting), mirroring the sibling job:

```sql
-- ssh to the host that can reach prod RDS, then psql:
CREATE INDEX CONCURRENTLY IF NOT EXISTS flowsheet_linked_reenrichment_idx
  ON wxyc_schema.flowsheet (id)
  WHERE metadata_status = 'enriched_no_match'
    AND album_id IS NOT NULL
    AND artist_name IS NOT NULL;
```

### 2. Pre-flight: confirm no sibling cron is mid-run

The 06:00 UTC `flowsheet-metadata-backfill` cron and this job both touch the flowsheet metadata columns. Don't run them together (`docker ps -a`).

### 3. Dry-run, then execute

```bash
docker run --rm --name flowsheet-linked-reenrichment --env-file .env \
  <ECR-URI>/flowsheet-linked-reenrichment:<tag>              # dry-run (default)
docker run --rm --name flowsheet-linked-reenrichment --env-file .env \
  <ECR-URI>/flowsheet-linked-reenrichment:<tag> --execute    # writes
```

Run off-peak. Dry-run performs the Lane A scope count and logs it with zero writes.

### 4. Post-run verification (comment on BS#1443)

Post the final counters (`lane_a_candidates`, `flipped_from_album_metadata`) from the `finished` log line, then re-count the cohort. The residual after Lane A is the population Lane B will target:

```sql
SELECT count(*) FROM wxyc_schema.flowsheet
WHERE metadata_status = 'enriched_no_match'
  AND album_id IS NOT NULL
  AND artist_name IS NOT NULL
  AND add_time < '2026-06-16T17:53:53Z'::timestamptz;
```

### 5. Post-run: drop the one-shot index (only after Lane B has also run)

Lane B reuses the same index, so leave it in place until both lanes are done:

```sql
DROP INDEX CONCURRENTLY IF EXISTS wxyc_schema.flowsheet_linked_reenrichment_idx;
```

## Idempotency & resume

- Re-running is a no-op on already-flipped rows (they leave the `enriched_no_match` predicate).
- Lane A's flip is self-resuming (flipped rows drop out; no cursor needed).

## Environment variables

| Var                               | Default  | Purpose                                                      |
| --------------------------------- | -------- | ------------------------------------------------------------ |
| `LINKED_REENRICH_FLIP_BATCH_SIZE` | `5000`   | Rows per flip UPDATE transaction.                            |
| `LINKED_REENRICH_FLIP_TIMEOUT_MS` | `300000` | Statement timeout per flip batch.                            |
| `LINKED_REENRICH_READ_TIMEOUT_MS` | `300000` | Statement timeout for the count SELECT.                      |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`  | `300`    | Cooperative-pause lookback; `0` disables.                    |
| `DB_*`, `SENTRY_*`                | —        | Standard DB + observability config (see `docs/env-vars.md`). |

## References

- BS#1638 — this job. BS#1443 — parent decision ticket (Option 1 chosen).
- BS#1041 (`jobs/album-level-backfill`) — structural donor (distinct-album enrich + paired row flip).
- BS#1433 (`jobs/flowsheet-reenrichment`) — unlinked-cohort drain; documented this cohort as its orphan-rescue target.
- BS#1011 / BS#895 — cron retirement + C6 retune; deliberately untouched by this job.
