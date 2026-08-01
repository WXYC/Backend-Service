# @wxyc/flowsheet-metadata-backfill

Enriches `flowsheet` **track** rows (album `artwork_url`, streaming links, `album_metadata` linkage) that the live CDC enrichment worker (`apps/enrichment-worker`, Epic C C2 / BS#892) didn't cover. The job runs in two modes with the same code and eligibility logic, selected entirely by env:

1. **Recurring gap-recovery sweep** (default, cron `10 * * * *`) — Epic C **C6** (BS#895). The safety net behind the CDC consumer: catches rows the consumer missed, bounded by a grace window and a hard age ceiling so it only ever looks at recent misses (tens of rows/hour). This is the job's production identity.
2. **Historical catch-up drain** (`BACKFILL_RECOVERY_WINDOW_HOURS=0`) — a one-shot walk over the entire `metadata_status='pending'` track cohort. This is how the ~748k-row backlog that BS#1011 left behind (and BS#895's ceiling fenced off) gets drained. Not a cron; launched by hand and monitored.

The cohort in both modes is the same: `metadata_status = 'pending' AND entry_type = 'track' AND artist_name IS NOT NULL`. `metadata_status` is the canonical lifecycle gate (BS#891) — the job only ever reads `pending` rows and transitions them monotonically to a terminal state; it never re-opens a row.

## What it does

For each eligible row, in **play-count-descending** priority (highest-play artists first), it calls LML via the single-item `POST /api/v1/lookup` through the `@wxyc/lml-client` chokepoint (deliberately **not** `/lookup/bulk` — see [Why single-row](#why-single-row-not-bulk)) and applies the result:

- **match** → writes the streaming/artwork columns and flips the row to `enriched_match`.
- **no match / LML timeout body** → flips to `enriched_no_match` (the 35 s per-call budget is sized so a cascade-timeout body still drains the row instead of looping it every pass — see `lml-fetch.ts`).
- **transient LML error** → left `pending`, retried on a later pass (`lml_error` counter).
- **permanent write error** (mojibake varchar overflow, SQLSTATE 22/23) → dead-lettered to `failed_no_retry` so it can't wedge the cursor (`enrich_error`, `dead_lettered: true`).

A run-scoped `(artist, album)` dedup cache (`lookup-cache.ts`) short-circuits repeat pairs — prod-measured 1.74× (628,561 pending unlinked rows → 362,258 distinct pairs), cutting the LML call budget ~42%. The play-descending ordering clusters same-artist rows so the cache stays warm.

## Eligibility and the play-floor

The work-list is `linked rows ∪ library-artist rows ∪ non-library artists with ≥ BACKFILL_NONLIBRARY_PLAY_FLOOR lifetime plays`. Non-library artists **below** the floor are excluded at query time (counted `below_floor_skipped`, never stamped) — this is the deep one-off tail (BS#1591), simultaneously the lowest value (mostly `enriched_no_match` — no metadata exists) and the highest risk (each is a live Discogs call against the shared 50/min ceiling). Keeping the floor at its default of `5` holds the cold tail small. Set `BACKFILL_NONLIBRARY_PLAY_FLOOR=0` to drain the full tail (slower, more Discogs pressure).

## Run procedure (historical catch-up)

```bash
# 1. Build & push the image via GitHub Actions (only if main moved since the last deploy)
gh workflow run deploy-manual.yml --ref main -f target=flowsheet-metadata-backfill -f version=latest

# 2. SSH to BS EC2 (see MEMORY.md / reference_bs_prod_db_query_path.md for access)
ssh wxyc-ec2

# 3. Pause the hourly cron so its limiter bucket doesn't combine with the drain's
#    (the token bucket is per-process; two concurrent runs = two buckets).
crontab -l > ~/crontab.backup.predrain
crontab -l | sed "/^[^#].*flowsheet-metadata-backfill-cron/ s/^/#DRAIN-PAUSED /" | crontab -

# 4. Launch detached, catch-up env. Detached (-d) because a full drain is multi-day.
docker run -d --name flowsheet-metadata-backfill-catchup --env-file $HOME/.env \
  -e BACKFILL_RECOVERY_WINDOW_HOURS=0 \
  -e BACKFILL_FLOOR_RECENCY_DAYS=0 \
  -e BACKFILL_NONLIBRARY_PLAY_FLOOR=5 \
  -e LIVE_ACTIVITY_LOOKBACK_SECONDS=60 \
  -e BACKFILL_LML_MAX_CONCURRENT=1 \
  -e BACKFILL_LML_RATE_PER_MIN=40 \
  <image>

# 5. Read the eligible size + throughput
docker logs -f flowsheet-metadata-backfill-catchup   # look for worklist_built, then batch_done

# 6. On completion: remove the exited container and RESTORE the cron
docker rm flowsheet-metadata-backfill-catchup
crontab ~/crontab.backup.predrain   # or un-comment the #DRAIN-PAUSED line
```

The drain is **resumable**: it has no persisted cursor — a restart rebuilds the work-list from the `pending` filter alone, so already-drained rows (now non-`pending`) are simply excluded. Throttling down = `docker rm -f` + re-run at a lower rate (the limiter reads env only at process start).

### Monitoring (a catch-up run competes with live traffic on LML's single event loop)

| Signal                                     | Source                                              | Back off if                                    |
| ------------------------------------------ | --------------------------------------------------- | ---------------------------------------------- |
| `UserFacingCheckFailure`, `LookupDegraded` | `WXYC/Canary` CloudWatch (`aws --profile wxyc-api`) | any non-zero                                   |
| LML `/api/v1/lookup` p95                   | Sentry (`wxyc/library-metadata-lookup`)             | sustained > ~2 s (healthy baseline 0.35–0.8 s) |
| `discogs_rate_gate_fail_open`              | LML PostHog/Sentry (LML#879)                        | sustained climb                                |
| drain `lml_error` in `batch_done`          | `docker logs`                                       | spike = LML shedding                           |

Other heavy LML crons (`rotation-release-id-backfill`, `rotation-artist-backfill`, `catalog-popularity-freetext-resolve`, `rotation-lml-identity-backfill`) hit the same event loop in the `04:00–09:00 UTC` band; correlate self-resolving p95 bumps with their ticks before throttling.

## Env knobs

| Variable                              | Default      | Meaning                                                                                                                                                |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKFILL_RECOVERY_WINDOW_HOURS`      | `6`          | Hard age ceiling: only enrich rows added within this many hours. **`0` disables it** → the full historical catch-up cohort.                            |
| `BACKFILL_GRACE_MINUTES`              | `15`         | Consumer grace window: skip rows younger than this so the CDC worker gets first crack. `0` disables.                                                   |
| `BACKFILL_NONLIBRARY_PLAY_FLOOR`      | `5`          | Exclude non-library artists with fewer lifetime plays (BS#1591). `0` drains the full tail.                                                             |
| `BACKFILL_FLOOR_RECENCY_DAYS`         | `30`         | Recency exemption to the play-floor: recently-played rows below the floor still drain. `0` = pure catch-up.                                            |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`      | `60`         | Cooperative pause (#735): defer if a track was inserted within this window. `0` disables (max throughput; not recommended while on-air).               |
| `LIVE_ACTIVITY_PAUSE_MS`              | `30000`      | Sleep between re-probes when DJ activity is detected.                                                                                                  |
| `BACKFILL_LML_MAX_CONCURRENT`         | `1`          | Semaphore permits. Keep at `1` — BS#994: a single in-flight backfill lookup already head-of-line-blocked live iOS/dj-site traffic; two is worse.       |
| `BACKFILL_LML_RATE_PER_MIN`           | `20`         | Token-bucket cap on LML calls/min. Shared-ceiling-aware; raise for a monitored catch-up (40–50). In-process — a running container ignores env changes. |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS`    | `35000`      | Per-call abort budget. Sized to clear LML#370's 25.25 s cascade cap + headroom so a timeout body drains the row instead of looping it.                 |
| `BACKFILL_BATCH_SIZE`                 | `500`        | Rows per cursor page.                                                                                                                                  |
| `BACKFILL_THROTTLE_MS`                | `100`        | Sleep after each non-cache-hit row (extra Discogs pacing; skipped on cache hits).                                                                      |
| `PARTITION_COUNT` / `PARTITION_INDEX` | _(unset)_    | Optional sharding: run N containers each owning `id % N == index`.                                                                                     |
| `BACKFILL_CRON_SCHEDULE`              | `10 * * * *` | Cron cadence (GHA repo var, BS#914). From `package.json` `cron-schedule`.                                                                              |
| `LIBRARY_METADATA_URL`                | _(req)_      | LML base URL. Fails fast if unset.                                                                                                                     |
| `LML_API_KEY`                         | _(req)_      | LML bearer auth.                                                                                                                                       |

## Counters

Each `batch_done` and the final `finished` log line carry: `scanned`, `enriched_match(_raced)`, `enriched_no_match(_raced)`, `lml_error`, `enrich_error`, `below_floor_skipped`, `stale_skipped`, `worker_reconciled`, `worker_inflight_skipped`, `stranded_past_recovery_window`, the `self_heal_*` set (epic #1810 W4 rotation-link re-enrichment pass), and `cache_hits/misses/size/overwrites`. `*_raced` = a concurrent CDC-worker enrichment won the row between our SELECT and write (race-guarded, idempotent no-op).

## Why single-row, not bulk

This job intentionally uses `POST /api/v1/lookup`, not `/lookup/bulk`. Its throughput is bound by LML's single event loop and the shared Discogs 50/min ceiling, **not** HTTP-roundtrip count — and its dedup cache already captures the cache-warming benefit bulk offers. A live catch-up run at `MAX_CONCURRENT=1` self-limits to ~24 LML calls/min, below even a 40/min cap, confirming the bottleneck is per-call latency × concurrency. Swapping to bulk was evaluated and declined in BS#1909 (closed). The linked-`album_id` slice that _is_ bulk-friendly is drained separately by `album-level-backfill` (BS#1041); this job owns the free-form (no-`album_id`) residual.

## Operational notes

- **Do not run `scripts/sync/reconcile.ts` (the CDC monitor) during a catch-up window** — a full drain emits up to ~1.86M CDC events and the reconciler floods.
- **Pause the hourly cron before a catch-up run** (step 3 above) and restore it after. The limiter is per-process, so a concurrent cron run adds a second rate bucket against the shared Discogs ceiling.
- **Deploy re-arm caveat**: `deploy-base.yml` rebuilds the crontab from the canonical active line on any `main` deploy that marks this target affected (a shared-dep change marks all targets). A paused cron silently returns after such a deploy — re-check during a multi-day drain, or freeze `main` deploys for the window.

## Race guards

- Per-row write is `... WHERE id = $1 AND metadata_status = 'pending'` (and column guards for the specific write). A concurrent enrichment that flipped the status kicks the row out of the predicate; the write no-ops and is counted `*_raced`.
- The cursor is monotonic (`worklist_cursor` only advances), so a transient-error row that stays `pending` is not re-scanned within the same run — it's picked up on the next run/pass.
- Concurrent overlap with the live CDC worker is safe by construction (idempotent claim + race-guarded writes).

## Related

- Epic parent: BS#631. Siblings: BS#638 (job), BS#639 (`metadata_attempt_at` marker), BS#640 (pilot), BS#641 (rollout), BS#642 (this README + close-out) — all closed except #642.
- Epic C: BS#877 (event-driven enrichment), BS#892 (CDC consumer), BS#895 (this job as the C6 recovery sweep + the historical-backlog ceiling), BS#1011 (retired the daily drain).
- Pacing history: BS#994 / BS#995 (the single-in-flight head-of-line-blocking incident that fixed `MAX_CONCURRENT=1`).
- Sibling drains: `album-level-backfill` (BS#1041, linked albums via bulk), `flowsheet-artwork-repair` (BS#1209), `flowsheet-linked-reenrichment` (BS#1638).
- Declined bulk swap: BS#1909.
