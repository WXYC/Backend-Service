# @wxyc/library-identity-consumer

One-shot ETL job that consumes LML's `POST /api/v1/identity/bulk-resolve-libraries` endpoint and UPSERTs the verdicts into Backend's `library_identity` + `library_identity_source` tables. Implements [BS#802](https://github.com/WXYC/Backend-Service/issues/802) under the post-[BS#800](https://github.com/WXYC/Backend-Service/issues/800) cross-cache-identity pivot: LML is the sole composer of cross-cache identity; Backend is a thin writer.

This package replaces `jobs/library-identity-backfill/` (which composed identity inside Backend by reading from multiple sources). The new shape is a single HTTP fan-out per batch.

## What it does

For every `library` row where

```
library.canonical_entity_id IS NOT NULL
OR library.id IN (
  SELECT library_id FROM library_identity
  WHERE last_verified_at < NOW() - interval '7 days'
)
```

the job batches up to 500 inputs into one `POST /api/v1/identity/bulk-resolve-libraries` call (LML caps at 1000; we leave headroom) and, for each `BulkResolveResult`:

1. `kind: 'single_artist'` — open `db.transaction()`, write one row per provenance entry into `library_identity_source` (`ON CONFLICT (library_id, source) DO UPDATE`), then UPSERT the denormalised main row into `library_identity` (`ON CONFLICT (library_id) DO UPDATE`). The `(method, confidence)` on the main row come straight from LML.
2. `kind: 'unresolved'` — count, no write.
3. `kind: 'compilation'` — count as `rows_skipped { compilation }`; per-track writes are [BS#801](https://github.com/WXYC/Backend-Service/issues/801)'s scope.

On a batch-level LML error, every input is counted as `rows_skipped { lml_error: <count> }` and the loop continues; the next run re-picks the failed rows via the SELECT predicate (idempotent).

> **Note on the ticket text vs. the schema.** [BS#802](https://github.com/WXYC/Backend-Service/issues/802)'s body wrote `last_refreshed_at`, but the column on `library_identity` is `last_verified_at`. The SELECT predicate uses the actual column name; the PR body calls out the rename so the reviewer sees it.

## Run command

Build via `Manual Build & Deploy` with `target=library-identity-consumer`, then on EC2:

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
  docker run --rm -d --name lib-id-consumer-$i \
    --env-file .env \
    -e PARTITION_INDEX=$i -e PARTITION_COUNT=4 \
    <ecr-image-uri>:<tag>
done
```

## Dry run

Set `DRY_RUN=true` to call LML without writing. The job emits a single JSON object on stdout with the locked schema:

```json
{
  "scanned": 12345,
  "lml_total_calls": 25,
  "lml_total_latency_ms": 47000,
  "would_resolve": 11800,
  "would_unresolved": 420,
  "would_skip": {
    "compilation": 125,
    "lml_error": 0
  }
}
```

DRY_RUN still calls LML so the resolve / unresolved / error counts are honest predictions of the real run — only DB writes are suppressed.

```bash
docker run --rm --env-file .env -e DRY_RUN=true <ecr-image-uri>:<tag>
```

## Environment variables

| Variable                    | Default       | Purpose                                                                              |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`              | —             | Backend PostgreSQL connection string (required)                                      |
| `LIBRARY_METADATA_URL`      | —             | LML base URL (required); trailing `/api/v1` is stripped                              |
| `LML_API_KEY`               | unset         | Bearer token; sent as `Authorization: Bearer …` when set (LML enforces auth in prod) |
| `BATCH_SIZE`                | `500`         | Inputs per `bulk-resolve-libraries` call; LML caps at 1000                           |
| `THROTTLE_MS`               | `100`         | Inter-batch sleep, ms (DB + LML pacing)                                              |
| `STALE_THRESHOLD_DAYS`      | `7`           | Days before a `library_identity` row is re-fetched                                   |
| `PARTITION_INDEX`           | `0`           | Index of this partition (0-based)                                                    |
| `PARTITION_COUNT`           | `1`           | Total partition count; `1` = single-container run                                    |
| `DRY_RUN`                   | unset         | Locked truthy `true`/`1`/`TRUE`: call LML, suppress writes, emit JSON                |
| `SENTRY_DSN`                | unset         | Optional; Sentry no-ops when unset                                                   |
| `SENTRY_TRACES_SAMPLE_RATE` | `0`           | Sampling rate for the run span (0–1)                                                 |
| `WXYC_SCHEMA_NAME`          | `wxyc_schema` | Override only for parallel Jest workers / integration harnesses                      |

## Idempotency & rerun safety

Every write is an UPSERT; the SELECT predicate moves freshly-written rows out of the staleness bucket. Rerunning is safe.

On a batch-level LML failure, every input is counted as `rows_skipped { lml_error }` and the loop continues to the next batch. The next run re-picks those rows via the SELECT predicate. No tombstone or attempt-marker column is used — the predicate itself is the resumability mechanism.

## Sentry metrics

The job emits a top-level `library-identity-consumer.run` span. Run totals land as `consumer.*` attributes so trace explorer can pivot on them:

- `consumer.scanned`
- `consumer.rows_resolved`
- `consumer.rows_unresolved`
- `consumer.rows_skipped.compilation`
- `consumer.rows_skipped.lml_error`
- `consumer.rows_skipped.writer_error`
- `consumer.lml_total_calls`
- `consumer.lml_total_latency_ms`

Each batch's LML POST is wrapped in `lml.bulk_resolve_libraries` (`http.client`); LML's `cache_stats` payload projects onto the same span as `lml.cache.*` attributes (LML#229 pattern).

## Known scope cuts

1. **`kind: 'compilation'` is counted and skipped.** Per-track identity writes for compilations are [BS#801](https://github.com/WXYC/Backend-Service/issues/801)'s scope; the writer's surface area for compilations (`library_track_identity_source`) is not in this PR.
2. **`ReconciledIdentity` artist-ID columns gap.** LML's payload carries `discogs_artist_id`, `musicbrainz_artist_id`, and `bandcamp_id` for the artist, but `library_identity` has no main-row destinations for them yet. The values flow into `library_identity_source.external_id` (text) via provenance rows, so no data is dropped — but the main row is a partial denormalised view until a follow-up migration adds artist-id columns. See the BS#802 PR body for the follow-up ticket.

## Plan reference

- Architecture pivot: [BS#800](https://github.com/WXYC/Backend-Service/issues/800) (cross-cache-identity 2026-05-09)
- API contract: [WXYC/wxyc-shared#104](https://github.com/WXYC/wxyc-shared/pull/104) (`api.yaml` v1.2.0)
- Endpoint deployment: [LML#272 / PR #273](https://github.com/WXYC/library-metadata-lookup/pull/273)
- Parent epic: [#663](https://github.com/WXYC/Backend-Service/issues/663) (E2 — Backend half)
