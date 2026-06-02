# @wxyc/artist-search-alias-consumer

Daily ETL job that consumes LML's `POST /api/v1/artists/search-aliases/bulk` endpoint and UPSERTs composed alias variants into Backend's `artist_search_alias` cache (migration 0089). Implements PR 4 of the [artist-search-alias plan](../../plans/artist-search-alias.md) ([BS#1266](https://github.com/WXYC/Backend-Service/issues/1266)).

The cache it populates is the storage substrate for the alias-aware catalog search (PR 5): any WXYC artist whose alias data has been ingested becomes findable by any cached variant of its name with zero LML hops at search time.

## What it does

For every distinct `library.artist_name` whose name group either has no `artist_search_alias` rows yet or has at least one stale row (`last_verified_at < NOW() - STALE_THRESHOLD_DAYS`):

1. Group by name → `{artist_name, artist_ids[]}` (multiple `artists.id` rows can share an `artist_name`; there's no UNIQUE constraint).
2. Filter V/A names client-side (`isCompilationArtist` substring match).
3. Batch ≤ 500 names into one `POST /api/v1/artists/search-aliases/bulk` call (LML caps at 1000).
4. For each resolved name: build the variant list (LML variants + `library.alternate_artist_name` values as `wxyc_library_alt` rows, confidence 0.85) and UPSERT one row per `(artist_id, source, variant)` for every artist_id in the name group.
5. Reconcile semantics: DELETE is scoped to `sources_present + 'wxyc_library_alt'` (the consumer always ran the local SELECT, so the alt leg is unambiguously "attempted"). An empty `sources_present` from LML is a no-op — the writer cannot distinguish "deleted upstream" from "leg didn't fire", so it leaves the cache untouched.

On a batch-level LML error, every input is counted as `names_missing` and the loop continues; the next run re-picks those names via the SELECT predicate (idempotent).

## Cron schedule

`cron-schedule` field in `package.json`: `15 4 * * *` UTC (00:15 ET, off-peak). The 15-minute offset from the top of the hour avoids head-of-line contention with the existing `artist-identity-etl` cron on LML's PG connection pool.

## Run command (manual one-shot)

Build via `Manual Build & Deploy` with `target=artist-search-alias-consumer`, then on EC2:

```bash
docker run --rm \
  --env-file .env \
  -e BATCH_SIZE=500 \
  -e THROTTLE_MS=100 \
  <ecr-image-uri>:<tag> \
  2>&1 | tee log
```

For a 4-way partitioned run (4 disjoint containers in parallel):

```bash
for i in 0 1 2 3; do
  docker run --rm -d --name asa-consumer-$i \
    --env-file .env \
    -e PARTITION_INDEX=$i -e PARTITION_COUNT=4 \
    <ecr-image-uri>:<tag>
done
```

Partition is by `hashtext(artist_name) % PARTITION_COUNT`, so distinct names land in distinct partitions deterministically.

## Dry run

Set `DRY_RUN=true` to call LML without writing. The job emits a single JSON object on stdout with the locked schema:

```json
{
  "names_scanned": 1234,
  "would_resolve": 1180,
  "would_missing": 54,
  "would_write_rows": 4920,
  "lml_total_calls": 3,
  "lml_total_latency_ms": 4700
}
```

DRY_RUN still calls LML so resolve/missing counts are honest predictions of the real run — only DB writes are suppressed.

```bash
docker run --rm --env-file .env -e DRY_RUN=true <ecr-image-uri>:<tag>
```

## Environment variables

| Variable                    | Default       | Purpose                                                                              |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`              | —             | Backend PostgreSQL connection string (required)                                      |
| `LIBRARY_METADATA_URL`      | —             | LML base URL (required); trailing `/api/v1` is stripped                              |
| `LML_API_KEY`               | unset         | Bearer token; sent as `Authorization: Bearer …` when set (LML enforces auth in prod) |
| `BATCH_SIZE`                | `500`         | Names per `artists/search-aliases/bulk` call; LML caps at 1000                       |
| `THROTTLE_MS`               | `100`         | Inter-batch sleep, ms (DB + LML pacing)                                              |
| `STALE_THRESHOLD_DAYS`      | `7`           | Days before an `artist_search_alias` row is re-fetched                               |
| `PARTITION_INDEX`           | `0`           | Index of this partition (0-based)                                                    |
| `PARTITION_COUNT`           | `1`           | Total partition count; `1` skips the modulo at the SQL level                         |
| `DRY_RUN`                   | unset         | Locked truthy `true`/`1`/`TRUE`: call LML, suppress writes, emit JSON                |
| `SENTRY_DSN`                | unset         | Optional; Sentry no-ops when unset                                                   |
| `SENTRY_TRACES_SAMPLE_RATE` | `0`           | Sampling rate for the run span (0–1)                                                 |
| `WXYC_SCHEMA_NAME`          | `wxyc_schema` | Override only for parallel Jest workers / integration harnesses                      |
| `DB_STATEMENT_TIMEOUT_MS`   | `60000`       | Set by `Dockerfile.artist-search-alias-consumer`; honored by `@wxyc/database`        |
| `DB_APPLICATION_NAME`       | (see Docker)  | Set by Dockerfile to `wxyc-artist-search-alias-consumer` for `pg_stat_activity` tags |

## Sentry metrics

The job emits a top-level `artist-search-alias-consumer.run` span. Run totals land as `consumer.*` attributes so trace explorer can pivot on them:

- `consumer.names_scanned`
- `consumer.names_resolved`
- `consumer.names_missing`
- `consumer.fanout_writes` — per-write count for groups with duplicate `artists.artist_name`; surfaces tubafrenzy data-quality regressions
- `consumer.source_rows_written`
- `consumer.lml_total_calls`
- `consumer.lml_total_latency_ms`

Each batch's LML POST is wrapped in `lml.artist_search_aliases_bulk` (`http.client`); LML's `cache_stats` payload projects onto the same span as `lml.cache.*` attributes (LML#229 pattern).

## Post-run verification SQL

```sql
-- (1) Cache fill rate per source. Expect roughly:
--     discogs_name_variation > discogs_member > discogs_alias > wxyc_library_alt
SELECT source, COUNT(*) FROM wxyc_schema.artist_search_alias GROUP BY source ORDER BY 2 DESC;

-- (2) Coverage — distinct artists with at least one alias row.
SELECT COUNT(DISTINCT artist_id) AS covered_artists FROM wxyc_schema.artist_search_alias;

-- (3) Variants for a canonical demo artist.
SELECT source, variant, method, confidence, last_verified_at
FROM wxyc_schema.artist_search_alias
WHERE artist_id IN (SELECT id FROM wxyc_schema.artists WHERE artist_name = '<canonical>')
ORDER BY source, variant;
```

## Idempotency & rerun safety

- Every write is an UPSERT keyed on `(artist_id, source, variant)`.
- The SELECT predicate moves freshly-written rows out of the staleness bucket.
- The cursor is the previous batch's last `artist_name`; pass `''` for the first batch (every real name sorts greater).
- The cursor advances by the **batch tail**, not by the eligible set, so an all-V/A batch cannot stall the loop.

## Known scope cuts

1. **No MusicBrainz alias source.** The substrate accommodates it (`source` is open-enum) but populating `musicbrainz_alias` rows requires an LML-side change beyond this PR's scope.
2. **No per-artist LML cache-warming.** If a name has no `entity.identity` row in LML, it comes back as `missing`; the orchestrator does not loop `missing` names through `GET /api/v1/discogs/artist/{id}`. The discogs-cache rebuild is the warming mechanism.
3. **`fanout_writes` is observability, not deduplication.** When `artists.artist_name` has collisions (≈235 groups in a recent prod clone), the cache writes the same variant set under each artist_id. The search side will return both. The dedup project is a sibling cleanup ticket, not a blocker.

## Plan reference

- Tracking issue: [BS#1266](https://github.com/WXYC/Backend-Service/issues/1266)
- Plan: [`plans/artist-search-alias.md`](../../plans/artist-search-alias.md) § PR 4
- Migration: [BS#1264](https://github.com/WXYC/Backend-Service/issues/1264) (closed; migration `0089_artist-search-alias.sql`)
- LML endpoint: [WXYC/library-metadata-lookup#480](https://github.com/WXYC/library-metadata-lookup/pull/480)
- ADR: [`docs/adr/0001-source-agnostic-artist-search-alias.md`](../../docs/adr/0001-source-agnostic-artist-search-alias.md)
