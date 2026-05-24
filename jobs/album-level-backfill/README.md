# @wxyc/album-level-backfill

One-shot historical backfill (BS#1041): enrich the ~35,692 unique pending album_ids in flowsheet via LML's bulk-lookup endpoint (LML#368), then flip the corresponding ~857k flowsheet rows from `metadata_status='pending'` to `enriched_match` in a paired post-pass UPDATE.

## When to run

After the per-row daily drain cron (`flowsheet-metadata-backfill-cron`) has run for a while and the residual is dominated by repeat plays of unenriched albums. Check the residual decomposition first:

```sql
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE album_id IS NULL) AS no_album_id,
  count(*) FILTER (WHERE album_id IS NOT NULL) AS linked_pending,
  count(DISTINCT album_id) FILTER (WHERE album_id IS NOT NULL) AS unique_album_ids
FROM wxyc_schema.flowsheet
WHERE entry_type = 'track'
  AND artist_name IS NOT NULL
  AND metadata_status = 'pending';
```

If `linked_pending / unique_album_ids > 5`, the dedup payoff justifies the run.

## How it works

1. `SELECT DISTINCT album_id` from pending flowsheet rows with non-null `album_id`.
2. Resolve each chunk of album_ids to `(artist_name, album_title)` via `library` + `artists` join.
3. Call LML `POST /api/v1/lookup/bulk` with batches of `BACKFILL_BULK_BATCH_SIZE` items (default 50).
4. For each `match` result, UPSERT into `album_metadata` with the same race-guarded `setWhere: updated_at < NOW()` shape the enrichment-worker uses.
5. After all bulk calls complete, ANALYZE `album_metadata`.
6. Cooperative pause until quiet, then post-pass UPDATE: `WITH matched AS (UPDATE flowsheet ... FROM album_metadata) SELECT count(*)`. Scoped inside `db.transaction` + `SET LOCAL statement_timeout`.

`no_match` items are not written to `album_metadata` (a row there semantically means "LML matched this album"); the per-row drain cron handles them via inline synthesized search URLs. `error` items are logged and left pending for the next drain-cron sweep.

## Run procedure (production)

```bash
# 1. Build & push image via GitHub Actions
gh workflow run deploy-manual.yml \
  --ref main \
  -f target=album-level-backfill \
  -f version=latest

# 2. SSH to the BS EC2 host (see MEMORY.md / reference_ec2_access.md)
ssh wxyc-ec2

# 3. Stop the per-row drain cron so it doesn't compete for LML rate
docker stop flowsheet-metadata-backfill-cron

# 4. Run a dry-run first to verify env + scope
docker run --rm --env-file .env <image> --dry-run

# 5. Run for real (expected wall-clock: ~12 hours at default 1 batch/min)
docker run --rm --env-file .env <image> 2>&1 | tee /tmp/album-level-backfill.log

# 6. Sanity check
psql "$DATABASE_URL" -c "SELECT count(*) FROM wxyc_schema.album_metadata;"
psql "$DATABASE_URL" -c "
  SELECT count(*) FROM wxyc_schema.flowsheet
  WHERE entry_type='track' AND metadata_status='pending' AND album_id IS NOT NULL;
"

# 7. Restart the per-row drain cron to handle the album_id IS NULL residual
docker start flowsheet-metadata-backfill-cron
```

## Env knobs

| Variable                                    | Default            | Meaning                                                 |
| ------------------------------------------- | ------------------ | ------------------------------------------------------- |
| `BACKFILL_BULK_BATCH_SIZE`                  | `50`               | Items per LML bulk request. LML caps at 100.            |
| `BACKFILL_BULK_RATE_PER_MIN`                | `1`                | Batches per minute. 1/min ≈ 50 items/min sustained.     |
| `BACKFILL_BULK_BUDGET_MS`                   | `25000`            | Forwarded to LML as `X-Caller-Budget-Ms`.               |
| `ALBUM_LEVEL_BACKFILL_POST_PASS_TIMEOUT_MS` | `14400000` (4h)    | `SET LOCAL statement_timeout` for the post-pass UPDATE. |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`            | `300`              | Cooperative-pause lookback window; `0` disables.        |
| `LIBRARY_METADATA_URL`                      | (required)         | LML base URL.                                           |
| `LML_API_KEY`                               | (required in prod) | LML bearer token.                                       |
| `DATABASE_URL`                              | (required)         | Postgres connection string.                             |

## Acceptance verification

After a successful run:

```sql
-- (1) album_metadata grew by ~36k rows (or close to it)
SELECT count(*) FROM wxyc_schema.album_metadata;

-- (2) The linked-pending bucket is near zero
SELECT count(*) FROM wxyc_schema.flowsheet
WHERE entry_type='track' AND metadata_status='pending' AND album_id IS NOT NULL;
-- Expected ≈ 0

-- (3) The no_album_id bucket is unchanged (per-row drain cron's territory)
SELECT count(*) FROM wxyc_schema.flowsheet
WHERE entry_type='track' AND metadata_status='pending' AND album_id IS NULL;
-- Expected ~744,449 (unchanged from pre-run)
```

## Related

- [BS#1041](https://github.com/WXYC/Backend-Service/issues/1041) — this job's parent issue.
- [LML#368](https://github.com/WXYC/library-metadata-lookup/issues/368) / [PR #369](https://github.com/WXYC/library-metadata-lookup/pull/369) — the bulk endpoint this job consumes.
- [BS#878](https://github.com/WXYC/Backend-Service/issues/878) — Epic D album_metadata extraction; this job materially advances the "album_metadata populated for ≥ 99% of distinct album_ids" criterion.
- [BS#1011](https://github.com/WXYC/Backend-Service/issues/1011) — the daily drain cron; this job handles the dedup-able 857k linked bucket while the cron handles the 744k no-album_id residual.
- [BS#995](https://github.com/WXYC/Backend-Service/issues/995) — the per-row cron's static-gate pacing, mirrored conceptually here as `BACKFILL_BULK_RATE_PER_MIN`.
- `docs/bulk-update-playbook.md` — paired ANALYZE rule + transaction-scoped statement_timeout pattern.
