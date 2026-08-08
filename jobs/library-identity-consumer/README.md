# @wxyc/library-identity-consumer

One-shot ETL job that consumes LML's `POST /api/v1/identity/bulk-resolve-libraries` endpoint and UPSERTs the verdicts into Backend's `library_identity` + `library_identity_source` tables, plus (as of [BS#1991](https://github.com/WXYC/Backend-Service/issues/1991)) per-track compilation credits into `compilation_track_artist`. Implements [BS#802](https://github.com/WXYC/Backend-Service/issues/802) under the post-[BS#800](https://github.com/WXYC/Backend-Service/issues/800) cross-cache-identity pivot: LML is the sole composer of cross-cache identity; Backend is a thin writer. BS#1991 ([#801](https://github.com/WXYC/Backend-Service/issues/801) S2) extends it to consume LML's per-track `kind: 'compilation'` results.

This package replaces `jobs/library-identity-backfill/` (which composed identity inside Backend by reading from multiple sources). The new shape is a single HTTP fan-out per batch.

## What it does

The job runs as **two sequential drains** — `va` (compilation-shaped rows) and `non_va` (everything else) — classified locally via `code_volume_letters LIKE 'Z%' OR EXISTS (compilation_track_artist row)`. Both always send `include_tracks: true`; the `va` drain pages small (`VA_BATCH_SIZE`, default 100) because a V/A release's track-credit payload can be large (S0/#1989 measured mean 56 credits/release, p99 483), while `non_va` pages full width (`BATCH_SIZE`). This split is a caller-side decision — LML's `include_tracks` flag is per-batch, not per-input.

For every `library` row where (the post-BS#1800 predicate `select.ts` actually emits; the `va` drain additionally honors the `unresolved_attempted_at` retry TTL — see the retry-marker section below)

```
library.canonical_entity_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM library_identity li
  WHERE li.library_id = library.id
    AND li.last_verified_at >= NOW() - interval '7 days'
)
```

each drain batches inputs into `POST /api/v1/identity/bulk-resolve-libraries` calls (LML caps at 1000 inputs) and, for each `BulkResolveResult`:

1. `kind: 'single_artist'` — open `db.transaction()`, write one row per provenance entry into `library_identity_source` (`ON CONFLICT (library_id, source) DO UPDATE`), then UPSERT the denormalised main row into `library_identity` (`ON CONFLICT (library_id) DO UPDATE`). The `(method, confidence)` on the main row come straight from LML.
2. `kind: 'unresolved'` — count, no write.
3. `kind: 'compilation'` whose per-track matcher ran this batch (`tracks_attempted === true`, response carries `tracks_contract_version === 1`) — a **resolved exit**, counted as `rows_resolved_compilation`. `writeCompilationTracks` (page-level, not per-result) fetches the page's `compilation_track_artist` rows in one query, resolves each track entry's `resolved_artist_name` to a local `artists.id` via a batched `fold_artist_name` join, and UPSERTs `track_artist_id` / `track_artist_link_confidence` / `track_artist_link_method = 'lml_backfill'` — never overwriting a row already linked by a librarian (`track_artist_link_method = 'librarian'`), and never touching an unchanged row — unchanged rows are filtered app-side before the UPDATE is even issued (the `library_watermark` trigger is `FOR EACH STATEMENT` and fires even on `UPDATE 0`, so the SQL-level `IS DISTINCT FROM` guard alone would not keep a no-op re-drain from advancing the watermark; it remains as a server-side backstop). A fully-unchanged page issues no UPDATE statement, so a no-op re-drain fires neither the CDC nor the watermark trigger. A CTA row with a NULL `track_position` gets the entry's position written verbatim when exactly one distinct position was offered at that `(artist_name, track_title)` key; two+ conflicting positions skip the position write (logged) without affecting the identity write.
4. `kind: 'compilation'` not yet visited by LML's matcher (no `tracks_contract_version`, or `tracks_attempted` not `true`) — counted as `rows_skipped { compilation }`, same as pre-BS#1991.

On a batch-level LML error, every input is counted as `rows_skipped { lml_error: <count> }` and the loop continues; the next run re-picks the failed rows via the SELECT predicate (idempotent).

### Compilation "resolved" semantics and the retry marker

A resolved compilation is a genuine resolution, not a "no-match" — so it is kept out of the same bucket that drives the `unresolved_attempted_at` no-match marker's population. But since compilations never write to `library_identity` (the marker `NOT EXISTS(library_identity row)` check would otherwise treat every resolved compilation as forever-unattempted), a resolved compilation's `library_id` is still stamped via the **same** `stampUnresolvedAttemptedAt` mechanism as genuine no-matches — it's the only durable per-library marker the schema has. Resolved compilations stamp in **every** flag state (the genuine no-match bucket keeps the BS#974 `INCLUDE_NULL_CANONICAL` gate), and the flag-off `va` eligibility predicate honors the marker's TTL, so the bound holds in the shipped default configuration too: a resolved compilation is re-asked at most once per `UNRESOLVED_RETRY_DAYS`, a large improvement over the pre-BS#1991 behavior (re-asked on every run, unbounded). `--recheck` (below) is the deliberate mechanism for revisiting the resolved cohort sooner, on demand.

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

Set `DRY_RUN=true` to call LML without writing. **Each drain** (`va`, then `non_va`) emits its own JSON object on stdout with the locked schema:

```json
{
  "scanned": 12345,
  "lml_total_calls": 25,
  "lml_total_latency_ms": 47000,
  "would_resolve": 11800,
  "would_resolve_compilation": 340,
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

## `--recheck` — on-demand re-drain of previously-attempted `va` rows

Set `RECHECK=true` to run a single `va`-cohort drain over **every** previously-attempted `va` row (`unresolved_attempted_at IS NOT NULL`), **ignoring** `UNRESOLVED_RETRY_DAYS` entirely. Note the marker doesn't distinguish resolved compilations from genuine no-matches or not-yet-askable rows, so this re-asks all three — the price of sharing one durable marker column. Use this after a deliberate LML matcher improvement, to re-ask rows without waiting out the TTL — the job doesn't poll for matcher improvements on its own ("store improvements propagate by deliberate re-drain, not polling"). Reuses the same paging/limiter/dry-run machinery as a normal run; `RECHECK=true` takes priority over the two-cohort drain and skips `non_va` entirely (compilations are inherently `va`).

```bash
docker run --rm --env-file .env -e RECHECK=true <ecr-image-uri>:<tag>
```

## Environment variables

| Variable                    | Default       | Purpose                                                                                                                              |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`              | —             | Backend PostgreSQL connection string (required)                                                                                      |
| `LIBRARY_METADATA_URL`      | —             | LML base URL (required); trailing `/api/v1` is stripped                                                                              |
| `LML_API_KEY`               | unset         | Bearer token; sent as `Authorization: Bearer …` when set (LML enforces auth in prod)                                                 |
| `BATCH_SIZE`                | `500`         | Inputs per `bulk-resolve-libraries` call for the `non_va` drain; LML caps at 1000                                                    |
| `VA_BATCH_SIZE`             | `100`         | BS#1991: inputs per call for the `va` drain — small, since `include_tracks` payloads can be large (S0/#1989 p99 483 credits/release) |
| `THROTTLE_MS`               | `100`         | Inter-batch sleep, ms (DB + LML pacing)                                                                                              |
| `STALE_THRESHOLD_DAYS`      | `7`           | Days before a `library_identity` row is re-fetched                                                                                   |
| `INCLUDE_NULL_CANONICAL`    | unset (off)   | BS#974 staged-rollout flag: `true`/`1` brings NULL-`canonical_entity_id` rows into scope (see below)                                 |
| `UNRESOLVED_RETRY_DAYS`     | `30`          | BS#974 no-match retry window for `unresolved_attempted_at` (separate from `STALE_THRESHOLD_DAYS`; flag-on everywhere, and always for the `va` drain — a resolved compilation's only durable exit) |
| `RECHECK`                   | unset (off)   | BS#1991: `true`/`1` runs the on-demand resolved-compilation re-drain instead of the normal two-cohort drain (see above)              |
| `PARTITION_INDEX`           | `0`           | Index of this partition (0-based)                                                                                                    |
| `PARTITION_COUNT`           | `1`           | Total partition count; `1` = single-container run                                                                                    |
| `DRY_RUN`                   | unset         | Locked truthy `true`/`1`/`TRUE`: call LML, suppress writes, emit JSON                                                                |
| `SENTRY_DSN`                | unset         | Optional; Sentry no-ops when unset                                                                                                   |
| `SENTRY_TRACES_SAMPLE_RATE` | `0`           | Sampling rate for the run span (0–1)                                                                                                 |
| `WXYC_SCHEMA_NAME`          | `wxyc_schema` | Override only for parallel Jest workers / integration harnesses                                                                      |

## Idempotency & rerun safety

Every write is an UPSERT; the SELECT predicate moves freshly-written rows out of the staleness bucket. Rerunning is safe.

On a batch-level LML failure, every input is counted as `rows_skipped { lml_error }` and the loop continues to the next batch. The next run re-picks those rows via the SELECT predicate. In the default (flag-off) mode no attempt-marker column is used — the predicate itself is the resumability mechanism. Under `INCLUDE_NULL_CANONICAL` (below), the `library.unresolved_attempted_at` marker additionally dedups a manual re-run of the no-match rows.

## BS#974 — covering NULL-`canonical_entity_id` rows (`INCLUDE_NULL_CANONICAL`)

By default the SELECT only considers `canonical_entity_id IS NOT NULL` rows, so the ~34K never-canonicalized libraries — including the ~6,300 V/A compilation rows LML has never classified ([#801](https://github.com/WXYC/Backend-Service/issues/801)) — are never scanned. `INCLUDE_NULL_CANONICAL=true` expands the predicate to cover them.

A row LML can't resolve never lands in `library_identity`, so it would be re-attempted on every run (LML quota burn). The `library.unresolved_attempted_at` marker (migration 0130) prevents that: a `kind: unresolved` row, a not-yet-askable `kind: compilation` row, AND (BS#1991) a **resolved** `kind: compilation` row are all stamped so a subsequent run skips them until `UNRESOLVED_RETRY_DAYS` (default 30) elapse — see "Compilation resolved semantics" above for why a genuine resolution still uses the no-match marker. `single_artist` resolutions are NOT stamped — their `library_identity` row is the success marker.

**This is a one-shot job with no cron backstop** — a stamped row is only re-attempted when an operator re-runs the job past the window. Flag off is byte-identical to the prior behavior.

**Staged rollout** (all manual `docker run` invocations):

1. Deploy the image with `INCLUDE_NULL_CANONICAL` unset → a run behaves exactly as before (zero-change verification).
2. `docker run … -e INCLUDE_NULL_CANONICAL=true -e DRY_RUN=true …` → confirm `scanned` jumps to ≈ the full library (~64,676) and `would_skip.compilation > 0` (V/A rows now classified).
3. Optionally subset-first with `PARTITION_INDEX` / `PARTITION_COUNT`.
4. `docker run … -e INCLUDE_NULL_CANONICAL=true …` for the live drain.

## Sentry metrics

The job emits a top-level `library-identity-consumer.run` span. Each drain's totals land as their own namespaced attributes so trace explorer can pivot on them without one drain overwriting the other: `consumer.va.*` / `consumer.non_va.*` for a normal run, `consumer.recheck.*` for a `--recheck` run.

- `<prefix>.scanned`
- `<prefix>.rows_resolved`
- `<prefix>.rows_resolved_compilation`
- `<prefix>.rows_unresolved`
- `<prefix>.rows_skipped.compilation`
- `<prefix>.rows_skipped.lml_error`
- `<prefix>.rows_skipped.writer_error`
- `<prefix>.rows_skipped.lml_cardinality_mismatch`
- `<prefix>.rows_skipped.lml_untrusted_library_id`
- `<prefix>.source_rows_skipped_null_confidence`
- `<prefix>.compilation_track_rows_written`
- `<prefix>.compilation_track_rows_skipped_librarian`
- `<prefix>.lml_total_calls`
- `<prefix>.lml_total_latency_ms`

Each batch's LML POST is wrapped in `lml.bulk_resolve_libraries` (`http.client`); LML's `cache_stats` payload projects onto the same span as `lml.cache.*` attributes (LML#229 pattern).

## Known scope cuts

1. **Non-V/A track data is out of scope.** Populating `compilation_track_artist` for the ~58K non-compilation releases is [BS#1994](https://github.com/WXYC/Backend-Service/issues/1994) (`#801` S5) — a separate, much larger drain with its own trigger-overhead strategy.
2. **`ReconciledIdentity` artist-ID columns gap.** LML's payload carries `discogs_artist_id`, `musicbrainz_artist_id`, and `bandcamp_id` for the artist, but `library_identity` has no main-row destinations for them yet. The values flow into `library_identity_source.external_id` (text) via provenance rows, so no data is dropped — but the main row is a partial denormalised view until a follow-up migration adds artist-id columns. See the BS#802 PR body for the follow-up ticket.

## Plan reference

- Architecture pivot: [BS#800](https://github.com/WXYC/Backend-Service/issues/800) (cross-cache-identity 2026-05-09)
- API contract: [WXYC/wxyc-shared#104](https://github.com/WXYC/wxyc-shared/pull/104) (`api.yaml` v1.2.0), extended by [#300](https://github.com/WXYC/wxyc-shared/pull/300)/[#307](https://github.com/WXYC/wxyc-shared/pull/307)/[#315](https://github.com/WXYC/wxyc-shared/pull/315) for the tracks contract (v1.33.0)
- Endpoint deployment: [LML#272 / PR #273](https://github.com/WXYC/library-metadata-lookup/pull/273)
- Compilation per-track identity: [BS#1991](https://github.com/WXYC/Backend-Service/issues/1991) (`#801` S2)
- Parent epic: [#663](https://github.com/WXYC/Backend-Service/issues/663) (E2 — Backend half), [#801](https://github.com/WXYC/Backend-Service/issues/801) (compilation track identity)
