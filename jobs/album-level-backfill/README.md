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
3. Call LML `POST /api/v1/lookup/bulk` with batches of `BACKFILL_BULK_BATCH_SIZE` items (default 5, lowered from 10 in BS#1197), with no budget header by default (see "No budget header" below). The per-batch fetch timeout scales with this value (`batchSize × 5 s + 5 s` slack, plus LML's 25-second hard cap when no header is sent) so a cascade-heavy batch can't exhaust the shared LML-client's 30 s default (BS#1178). The 2026-05-28 Phase 3 canary measured 38–50 % per-batch timeouts at `batchSize=10` vs 3–10 % at `batchSize=5` under live `enrichment-worker` contention, so smaller batches yield _higher_ net throughput.
4. For each `match` result, UPSERT into `album_metadata` with the same race-guarded `setWhere: updated_at < NOW()` shape the enrichment-worker uses. When the item's `lookup.degraded` is true (LML shed part of the enrichment tail, LML#1420), the conflict branch keeps what is already stored where the reply is null ([BS#3127](https://github.com/WXYC/Backend-Service/issues/3127), the same rule as the enrichment worker's BS#3117 `buildDegradedConflictSet`). `discogs_url` keeps the stored value. `artwork_url` and `release_year` keep the stored values only while the reply's `discogs_url` is null or unchanged. `artist_bio` / `artist_wikipedia_url` keep the stored values when both `discogs_artist_id`s are known and equal, or, when either is unknown, when the release is unchanged; this job never writes `discogs_artist_id`, so in practice the bio is kept only for the same release. A reply for a different release or artist is written as it is. The rule lives in `degraded-keep-sql.ts`, a copy of the enrichment worker's. A healthy reply with a null bio still clears the bio, and the INSERT branch is unchanged.
5. After all bulk calls complete, ANALYZE `album_metadata`.
6. Cooperative pause until quiet, then post-pass UPDATE: `WITH matched AS (UPDATE flowsheet ... FROM album_metadata) SELECT count(*)`. Scoped inside `db.transaction` + `SET LOCAL statement_timeout`.

`no_match` items are not written to `album_metadata` (a row there semantically means "LML matched this album"); the per-row drain cron handles them via inline synthesized search URLs. `error` items are logged and left pending for the next drain-cron sweep.

## No budget header (BS#2986)

`BACKFILL_BULK_BUDGET_MS` defaults to `0`, which sends no `X-Caller-Budget-Ms` header. It used to default to `25000`, but LML does not honor 25 seconds: it clamps any header to its own `LML_SEARCH_BUDGET_MS`, 4 seconds on production. Once an item has used its 4 seconds, LML skips the rest of the enrichment tail (`fetch_artwork`, then `enrich_metadata`, where the Spotify and Apple links and the bio come from) and answers `degraded: deadline_exceeded`. Under that clamp a shed album is still a `match`. If LML skipped `fetch_artwork`, the album gets no `album_metadata` row and stays pending. If it skipped only `enrich_metadata`, the job writes a row with artwork and no streaming links or bio, and the post-pass flips its plays to `enriched_match`: the frozen shape `streaming-columns-drain` had to heal (BS#2295).

**Measured rate: not measurable.** The job's last runs (May 2026, BS#1041 / BS#1078) predate LML's enrichment-tail shed (LML#930, July 2026) and Sentry's 30-day span retention, and their logs were not kept. Under the same clamp, `catalog-popularity-freetext-resolve` shed at least one item in 62% of its bulk requests over the 30 days to 2026-10-13, and `album-metadata-bio-fill` in 27 of its 29 before it dropped the header (BS#2978).

**Decision: send no header.** The fields this job writes come from the two steps a 4-second budget skips. With no header an item's search is bounded by LML's `LML_SEARCH_HARD_TIMEOUT_MS`, 25 seconds, which the bulk timeout assumes (`LML_HARD_CAP_MS`): 55 seconds for a batch of 5, up from 30. The cost is time: LML also drops its empty-results cutoff, so a no-match album searches until the cascade ends or the hard cap. `album-metadata-bio-fill`'s headerless requests took 9.9 s at the median and 14.8 s at p95, and 0 of 1,164 were shed. A positive value still sends the header, for anyone who wants the 4-second clamp back on purpose.

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

# 5. Run for real. At post-BS#1197 defaults (batch=5, rate=1/min ≈ 5 items/min)
#    a full 35,692-album drain takes ~120 h. For catch-up runs, bump
#    BACKFILL_BULK_RATE_PER_MIN (e.g. 6 → ~20 h) — keep BATCH_SIZE at 5
#    so the per-batch fetch-timeout headroom stays intact under live
#    enrichment-worker contention (see BS#1078 Phase 3 evidence).
docker run --rm --env-file .env <image> 2>&1 | tee /tmp/album-level-backfill.log

# 6. Sanity check
psql "$DATABASE_URL" -c "SELECT count(*) FROM wxyc_schema.album_metadata;"
psql "$DATABASE_URL" -c "
  SELECT count(*) FROM wxyc_schema.flowsheet
  WHERE entry_type='track' AND metadata_status='pending' AND album_id IS NOT NULL;
"

# 7. Do NOT restart the per-row drain cron yet. The 2026-05-24 firing
#    showed a 21% LML timeout rate (~2,200 of 10,500 rows). Investigation
#    in BS#1064 must finish before resuming the cron — otherwise it will
#    burn LML quota at a steady error rate for no net progress. The 744k
#    `album_id IS NULL` residual stays pending until then.
#
# docker start flowsheet-metadata-backfill-cron
```

## Env knobs

| Variable                                    | Default            | Meaning                                                                                                                                                                   |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKFILL_BULK_BATCH_SIZE`                  | `5`                | Items per LML bulk request. LML caps at 100. Raising this scales the fetch timeout (BS#1178); empirical post-LML#370 ceiling under live worker contention is 5 (BS#1197). |
| `BACKFILL_BULK_RATE_PER_MIN`                | `1`                | Batches per minute. At the default batch size, 1/min ≈ 5 items/min sustained.                                                                                             |
| `BACKFILL_BULK_BUDGET_MS`                   | `0`                | Per-item budget sent to LML as `X-Caller-Budget-Ms`; `0` sends no header. LML clamps any value to 4 s. See "No budget header". NOT the batch fetch timeout.               |
| `ALBUM_LEVEL_BACKFILL_POST_PASS_TIMEOUT_MS` | `14400000` (4h)    | `SET LOCAL statement_timeout` for the post-pass UPDATE.                                                                                                                   |
| `ALBUM_LEVEL_BACKFILL_READ_TIMEOUT_MS`      | `300000` (5min)    | `SET LOCAL statement_timeout` for the enumerate scan + per-batch resolveAlbums lookup.                                                                                    |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`            | `300`              | Cooperative-pause lookback window; `0` disables.                                                                                                                          |
| `LIBRARY_METADATA_URL`                      | (required)         | LML base URL.                                                                                                                                                             |
| `LML_API_KEY`                               | (required in prod) | LML bearer token.                                                                                                                                                         |
| `DATABASE_URL`                              | (required)         | Postgres connection string.                                                                                                                                               |

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
