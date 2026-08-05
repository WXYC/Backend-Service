# @wxyc/flowsheet-metadata-backfill

Enriches `flowsheet` **track** rows (album `artwork_url`, streaming links, `album_metadata` linkage) that the live CDC enrichment worker (`apps/enrichment-worker`, Epic C C2 / BS#892) didn't cover. The job runs in two modes with the same code and eligibility logic, selected entirely by env:

1. **Recurring gap-recovery sweep** (default, cron `10 * * * *`) — Epic C **C6** (BS#895). The safety net behind the CDC consumer: catches rows the consumer missed, bounded by a grace window and a hard age ceiling so it only ever looks at recent misses (tens of rows/hour). This is the job's production identity.
2. **Historical catch-up drain** (`BACKFILL_RECOVERY_WINDOW_HOURS=0`) — a one-shot walk over the entire `metadata_status='pending'` track cohort. This is how the ~748k-row backlog that BS#1011 left behind (and BS#895's ceiling fenced off) gets drained. Not a cron; launched by hand and monitored.

The cohort in both modes is the same: `metadata_status = 'pending' AND entry_type = 'track' AND artist_name IS NOT NULL`. `metadata_status` is the canonical lifecycle gate (BS#891) — the job only ever reads `pending` rows and transitions them monotonically to a terminal state; it never re-opens a row.

## What it does

For each eligible row, in **play-count-descending** priority (highest-play artists first), it calls LML via the single-item `POST /api/v1/lookup` through the `@wxyc/lml-client` chokepoint (deliberately **not** `/lookup/bulk` — see [Why single-row](#why-single-row-not-bulk)) and applies the result:

- **match** → writes the streaming/artwork columns and flips the row to `enriched_match`.
- **no match / LML timeout body** → flips to `enriched_no_match` (the 35 s per-call budget is sized so a cascade-timeout body still drains the row instead of looping it every pass — see `lml-fetch.ts`).
- **LML couldn't ask Discogs** (`degraded_reason: 'upstream_unavailable'` — LML's Discogs breaker was open) → **no verdict is written** (`upstream_unavailable_skipped` counter). The row stays `pending` for a later sweep instead of freezing as a false `enriched_no_match` — this is the BS#1995 fix for the 2026-08-03/04 incident. Bounded by the breaker gate below, not an unbounded retry loop.
- **transient LML error** → left `pending`, retried on a later pass (`lml_error` counter).
- **permanent write error** (mojibake varchar overflow, SQLSTATE 22/23) → dead-lettered to `failed_no_retry` so it can't wedge the cursor (`enrich_error`, `dead_lettered: true`).

Before each batch, the drain also probes LML's `/health` Discogs circuit breaker and pauses if it isn't `closed` — see [LML Discogs breaker gate](#lml-discogs-breaker-gate-bs1995) below.

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
#
#    BACKFILL_LML_RATE_PER_MIN=6, not 40 (BS#1995 incident, 2026-08-03/04):
#    this knob counts LML LOOKUPS, but the ceiling that matters is LML's
#    DISCOGS ceiling, and LML fans each lookup out to ~2.5 Discogs calls
#    (measured on prod: 51 req/min total at LML minus a 23 req/min
#    backfill-idle baseline = 28 req/min attributable, at 11.3 lookups/min
#    -> 28 / 11.3 ~= 2.5). Reserving ~15 Discogs req/min for this single
#    drain (well under half of LML's 50/min ceiling, leaving headroom for
#    live traffic + the other heavy crons in the 04:00-09:00 UTC band)
#    means BACKFILL_LML_RATE_PER_MIN must be <= 15 / 2.5 = 6 lookups/min.
#    That's exactly the value the incident's mitigation validated: 6 held
#    the no-match rate to 8-14% (below even the pre-incident ~25% baseline)
#    and kept LML's discogs_breaker_state closed for the rest of the run.
#    See "Env knobs" below for the full arithmetic and docs/env-vars.md's
#    "Backfill LML rate gating" section for the fan-out caveat.
docker run -d --name flowsheet-metadata-backfill-catchup --env-file $HOME/.env \
  -e BACKFILL_RECOVERY_WINDOW_HOURS=0 \
  -e BACKFILL_FLOOR_RECENCY_DAYS=0 \
  -e BACKFILL_NONLIBRARY_PLAY_FLOOR=5 \
  -e LIVE_ACTIVITY_LOOKBACK_SECONDS=60 \
  -e BACKFILL_LML_MAX_CONCURRENT=1 \
  -e BACKFILL_LML_RATE_PER_MIN=6 \
  <image>

# 5. Read the eligible size + throughput
docker logs -f flowsheet-metadata-backfill-catchup   # look for worklist_built, then batch_done

# 6. On completion: remove the exited container and RESTORE the cron
docker rm flowsheet-metadata-backfill-catchup
crontab ~/crontab.backup.predrain   # or un-comment the #DRAIN-PAUSED line
```

The drain is **resumable**: it has no persisted cursor — a restart rebuilds the work-list from the `pending` filter alone, so already-drained rows (now non-`pending`) are simply excluded. Throttling down = `docker rm -f` + re-run at a lower rate (the limiter reads env only at process start).

### Monitoring (a catch-up run competes with live traffic on LML's single event loop)

**`lml_error` in `batch_done` is NOT a sufficient back-off signal, and never was (BS#1995).** When LML's Discogs circuit breaker is open it returns HTTP 200 with empty results — not an error. Across the entire 3-day run of the 2026-08-03/04 incident, `lml_error` totalled 7. The signal that actually moves during a breaker-open event is `discogs_breaker_state` (below) — read it, not `lml_error`.

| Signal                                                      | Source                                              | Back off if                                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserFacingCheckFailure`, `LookupDegraded`                  | `WXYC/Canary` CloudWatch (`aws --profile wxyc-api`) | any non-zero                                                                                                                                    |
| LML `/api/v1/lookup` p95                                    | Sentry (`wxyc/library-metadata-lookup`)             | sustained > ~2 s (healthy baseline 0.35–0.8 s)                                                                                                  |
| `discogs_rate_gate_fail_open`                               | LML PostHog/Sentry (LML#879)                        | sustained climb                                                                                                                                 |
| `discogs_breaker_state` in `batch_done` / LML `/health`     | `docker logs`, LML `/health`                        | anything other than `closed`                                                                                                                    |
| `discogs_req_per_min_measured` in `batch_done`              | `docker logs`                                       | sustained near or above ~50 (LML's Discogs ceiling — see "Env knobs")                                                                           |
| `upstream_unavailable_skipped` in `batch_done` / `finished` | `docker logs`                                       | any non-zero — the drain is refusing to write verdicts because LML couldn't reach Discogs                                                       |
| `breaker_pauses` in `batch_done` / `finished`               | `docker logs`                                       | sustained climb — the breaker gate is pausing often                                                                                             |
| ~~drain `lml_error` in `batch_done`~~                       | `docker logs`                                       | **not sufficient — see above.** A breaker-open response is a 200 with empty results, so this counter stays flat through the whole failure mode. |

The drain's own breaker gate (`orchestrate.ts`'s `waitForClosedBreaker`, [BS#1995 Arm 2](#lml-discogs-breaker-gate-bs1995)) already pauses automatically on a non-`closed` breaker — the signals above are for an operator watching a catch-up run, not a substitute for the gate.

Other heavy LML crons (`rotation-release-id-backfill`, `rotation-artist-backfill`, `catalog-popularity-freetext-resolve`, `rotation-lml-identity-backfill`) hit the same event loop in the `04:00–09:00 UTC` band; correlate self-resolving p95 bumps with their ticks before throttling.

## Env knobs

| Variable                                  | Default      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKFILL_RECOVERY_WINDOW_HOURS`          | `6`          | Hard age ceiling: only enrich rows added within this many hours. **`0` disables it** → the full historical catch-up cohort.                                                                                                                                                                                                                                                                                                                                                                  |
| `BACKFILL_GRACE_MINUTES`                  | `15`         | Consumer grace window: skip rows younger than this so the CDC worker gets first crack. `0` disables.                                                                                                                                                                                                                                                                                                                                                                                         |
| `BACKFILL_NONLIBRARY_PLAY_FLOOR`          | `5`          | Exclude non-library artists with fewer lifetime plays (BS#1591). `0` drains the full tail.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `BACKFILL_FLOOR_RECENCY_DAYS`             | `30`         | Recency exemption to the play-floor: recently-played rows below the floor still drain. `0` = pure catch-up.                                                                                                                                                                                                                                                                                                                                                                                  |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`          | `60`         | Cooperative pause (#735): defer if a track was inserted within this window. `0` disables (max throughput; not recommended while on-air).                                                                                                                                                                                                                                                                                                                                                     |
| `LIVE_ACTIVITY_PAUSE_MS`                  | `30000`      | Sleep between re-probes when DJ activity is detected.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BACKFILL_LML_MAX_CONCURRENT`             | `1`          | Semaphore permits. Keep at `1` — BS#994: a single in-flight backfill lookup already head-of-line-blocked live iOS/dj-site traffic; two is worse.                                                                                                                                                                                                                                                                                                                                             |
| `BACKFILL_LML_RATE_PER_MIN`               | `20`         | Token-bucket cap on LML **lookups**/min — NOT the same unit as LML's Discogs ceiling. LML fans each lookup out to ~2.5 Discogs calls (measured BS#1995), so this knob cannot by itself defend the shared ceiling; see [LML Discogs breaker gate](#lml-discogs-breaker-gate-bs1995) for the mechanism that actually can, and the run-procedure comment above for the arithmetic behind the recommended catch-up value (`6`, not 40–50). In-process — a running container ignores env changes. |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS`        | `35000`      | Per-call abort budget. Sized to clear LML#370's 25.25 s cascade cap + headroom so a timeout body drains the row instead of looping it.                                                                                                                                                                                                                                                                                                                                                       |
| `BACKFILL_BATCH_SIZE`                     | `500`        | Rows per cursor page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BACKFILL_THROTTLE_MS`                    | `100`        | Sleep after each non-cache-hit row (extra Discogs pacing; skipped on cache hits).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BACKFILL_BREAKER_PROBE_INTERVAL_BATCHES` | `1`          | BS#1995 Arm 2. Probe LML `/health`'s Discogs breaker every N batches (`1` = every batch — already "per batch, not per row"). `0` disables the gate entirely (always fails open, never probes). Invalid values warn and fall back (`Number()`-based, matches `lml-fetch.ts`'s convention).                                                                                                                                                                                                    |
| `BACKFILL_BREAKER_PAUSE_MS`               | `30000`      | BS#1995 Arm 2. Sleep between re-probes while the breaker stays non-`closed` (`open`/`half_open`). `0` = re-probe immediately (busy-poll — not recommended).                                                                                                                                                                                                                                                                                                                                  |
| `BACKFILL_BREAKER_PROBE_TIMEOUT_MS`       | `5000`       | BS#1995 Arm 2. Abort budget for the `/health` probe itself. A probe that times out, network-errors, or 4xx/5xxs fails OPEN (drain continues) — see [LML Discogs breaker gate](#lml-discogs-breaker-gate-bs1995).                                                                                                                                                                                                                                                                             |
| `PARTITION_COUNT` / `PARTITION_INDEX`     | _(unset)_    | Optional sharding: run N containers each owning `id % N == index`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BACKFILL_CRON_SCHEDULE`                  | `10 * * * *` | Cron cadence (GHA repo var, BS#914). From `package.json` `cron-schedule`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LIBRARY_METADATA_URL`                    | _(req)_      | LML base URL. Fails fast if unset. Also the base for the Arm 2 `/health` breaker probe.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LML_API_KEY`                             | _(req)_      | LML bearer auth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## LML Discogs breaker gate (BS#1995)

The 2026-08-03/04 incident: `BACKFILL_LML_RATE_PER_MIN` is a process-local token bucket counting this job's own LML lookups, but the constraint that actually matters — LML's Discogs rate ceiling — is shared across this drain, live iOS/dj-site traffic, and every other heavy cron in the `04:00–09:00 UTC` band. No process-local counter can see that sum. LML itself can, via its Discogs circuit breaker: `GET /health` exposes `discogs_breaker_state` (`closed` / `open` / `half_open`, `null` when Discogs is unconfigured) and `discogs_live_requests_total` (a monotonic per-process counter).

Before each batch (main sweep and W4 self-heal alike — never per row), the drain probes `/health` and gates on the result (`lml-health.ts` / `orchestrate.ts`'s `waitForClosedBreaker`):

- `closed` → proceeds.
- `open` / `half_open` → pauses for `BACKFILL_BREAKER_PAUSE_MS` and re-probes, looping until the breaker clears (`breaker_pauses` counter).
- `null` (Discogs unconfigured on this LML deploy) → fails open, proceeds. Nothing to protect.
- probe error (timeout, network failure, non-2xx) → fails open, proceeds, and logs a warning. A health-probe outage must never wedge the drain — that would trade one incident (an unnoticed breaker flap) for a worse one (a stuck cron).

Every probe's `discogs_live_requests_total` reading is diffed against the previous probe's to compute `discogs_req_per_min_measured` — a genuine measured requests-per-minute figure the process-local token bucket structurally cannot see, logged on `batch_done` alongside `discogs_breaker_state` and the raw `discogs_live_requests_total`. See "Env knobs" for the three tunables and "Monitoring" for how to read the resulting signals.

## Counters

Each `batch_done` and the final `finished` log line carry: `scanned`, `enriched_match(_raced)`, `enriched_no_match(_raced)`, `lml_error`, `enrich_error`, `upstream_unavailable_skipped` (BS#1995 Arm 3 — LML's Discogs breaker was open; no verdict was written), `below_floor_skipped`, `stale_skipped`, `worker_reconciled`, `worker_inflight_skipped`, `stranded_past_recovery_window`, the `self_heal_*` set (epic #1810 W4 rotation-link re-enrichment pass, including its own `self_heal_upstream_unavailable_skipped` twin), `breaker_probes` / `breaker_pauses` (BS#1995 Arm 2), `discogs_breaker_state` / `discogs_live_requests_total` / `discogs_req_per_min_measured` (BS#1995 Arm 2 — not counters, but the latest breaker-probe reading), and `cache_hits/misses/size/overwrites`. `*_raced` = a concurrent CDC-worker enrichment won the row between our SELECT and write (race-guarded, idempotent no-op).

## Why single-row, not bulk

This job intentionally uses `POST /api/v1/lookup`, not `/lookup/bulk`. Its throughput is bound by LML's single event loop and the shared Discogs 50/min ceiling, **not** HTTP-roundtrip count — and its dedup cache already captures the cache-warming benefit bulk offers. A live catch-up run at `MAX_CONCURRENT=1` measured 11.3 LML lookups/min (BS#1995, 2026-08-04) — well below even a 40/min cap, confirming the bottleneck is per-call latency × concurrency, not HTTP overhead. (An earlier, unmeasured "~24 calls/min" estimate in this section undersold the gap; 11.3 is the actual figure and is also the number the BS#1995 fan-out arithmetic above is built on.) Swapping to bulk was evaluated and declined in BS#1909 (closed). The linked-`album_id` slice that _is_ bulk-friendly is drained separately by `album-level-backfill` (BS#1041); this job owns the free-form (no-`album_id`) residual.

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
- BS#1995: the 2026-08-03/04 incident (26,387 rows frozen) that motivated the real-ceiling rate arithmetic above, the LML Discogs breaker gate, and the `upstream_unavailable_skipped` classification. `timeout: true` / `degraded_reason: 'deadline_exceeded'` / a bare-empty result stay terminal by design — see `enrich.ts`'s module docstring. Sibling classification bug in `apps/enrichment-worker`: BS#1977. One-shot repair of the frozen rows: BS#1979 — as filed, its cohort predicate (`add_time >= '2026-06-16T17:53:53Z'`) does NOT cover the BS#1995 rows, whose `add_time` predates that window (they came from the BS#1011 historical backlog, drained with `BACKFILL_RECOVERY_WINDOW_HOURS=0`).
