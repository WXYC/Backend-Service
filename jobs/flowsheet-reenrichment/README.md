# flowsheet-reenrichment

One-shot re-enrichment drain for BS#1433. Rescues ~11,965 `flowsheet` rows written as `enriched_no_match` before LML#583 (merged 2026-06-16T17:53:53Z) closed the library-miss recall gap.

BS#1823 adapted the same drain for a second run shape: re-enriching a recent, bounded slice of a _later_ regression backlog (see "Regression-window run" below), by adding an optional lower bound alongside the original cutoff.

BS#1998 added a third: the 26,286 rows the 2026-08-03/04 LML breaker incident froze outside WXYC/Backend-Service#1979's window (see "Incident-cohort run" below). Those rows span the whole `add_time` range and are selectable only by `updated_at`, so this run shape adds an independent window on that column — plus an opt-in `DRY_RUN` scope preview and a shed-vs-verdict split in the outcome counters.

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
   # Must show: Exited (any exit code is fine — running is not)
   ```

   If `docker ps -a` shows `Up …`, coordinate with #1011's resume sequence before launching.

3. **Build the partial index out-of-band** (avoids the AccessExclusiveLock that an in-migration DDL would take on the 2.6M-row `flowsheet` table). The cohort's WHERE has no covering index in the current schema — without this, each batch SELECT degrades to a heap scan as the cursor advances, multiplying wall-clock by orders of magnitude:

   ```sql
   -- ssh to the host that can reach prod RDS, then psql:
   CREATE INDEX CONCURRENTLY IF NOT EXISTS flowsheet_reenrichment_idx
     ON wxyc_schema.flowsheet (id)
     WHERE metadata_status = 'enriched_no_match'
       AND album_id IS NULL
       AND artist_name IS NOT NULL;
   ```

   `CONCURRENTLY` takes only a `ShareUpdateExclusiveLock`, so DJs continue inserting while the index builds (typically < 30 s for a partial covering ~12k of 2.6M rows). The index is one-shot — drop it after the run (see "Post-run").

4. **Run the pre-launch diagnostic** to understand the cohort partition:
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

# 2. SSH to EC2 and run. Tee logs to a file BEFORE relying on `docker
# logs` for the post-run summary — `--rm` auto-removes the container on
# exit, after which `docker logs flowsheet-reenrichment` returns "No
# such container" and the structured `finished`/`stopped` summary is
# unrecoverable. The tee'd file persists across container teardown.
#
# `--name` is load-bearing for the kill-switch below; without it docker
# assigns a random name and `docker stop flowsheet-reenrichment` fails.
ssh wxyc-ec2
docker run --rm --name flowsheet-reenrichment --env-file .env \
  -e BACKFILL_CUTOFF_TS='2026-06-16T17:53:53Z' \
  <ECR-URI>/flowsheet-reenrichment:<tag> 2>&1 \
  | tee /tmp/flowsheet-reenrichment-$(date +%Y%m%d-%H%M%S).log
```

> **Note on env-var read timing**: `lml-fetch.ts` reads `BACKFILL_LML_PER_CALL_TIMEOUT_MS` and `lml-limiter.ts` reads `BACKFILL_LML_MAX_CONCURRENT` / `BACKFILL_LML_RATE_PER_MIN` at module-load time. The `--env-file .env` pattern above passes env vars to the container's PID 1 (Node) so they're visible before any module loads. Do NOT export env vars from inside the container after start — they'll be silently ignored.

### Regression-window run (BS#1823)

The same drain also re-enriches a recent, bounded slice of a _later_ regression backlog — e.g. `enriched_no_match` / `album_id`-NULL flowsheet rows written while non-library resolution was briefly broken (the B3 regression, #1815 + LML#920). Set `BACKFILL_WINDOW_START_TS` (optionally alongside `BACKFILL_CUTOFF_TS`) instead of relying on the original pre-LML#583 cutoff alone:

```bash
docker run --rm --name flowsheet-reenrichment --env-file .env \
  -e BACKFILL_WINDOW_START_TS='2026-07-22T00:00:00Z' \
  <ECR-URI>/flowsheet-reenrichment:<tag> 2>&1 \
  | tee /tmp/flowsheet-reenrichment-window-$(date +%Y%m%d-%H%M%S).log
```

At least one of `BACKFILL_CUTOFF_TS` / `BACKFILL_WINDOW_START_TS` is required; the job fails fast (before scanning any rows) if neither is set. Window-start-only applies no upper bound (through "now", in effect) — the cohort is `add_time >= BACKFILL_WINDOW_START_TS`. Setting both narrows to their intersection. Each bound is validated independently as strict ISO 8601 (same rules as the original cutoff — see "Environment variables" below); a malformed value fails the same way a malformed cutoff always has.

No new LML flag is needed for either run shape: this job already calls LML via single `lookupMetadata` (`/lookup`), which defaults `allow_release_resolution_fallback=True` and therefore resolves non-library albums on its own — unlike `/lookup/bulk`, which the B3 regression traced to (WXYC/Backend-Service#1815).

**Dry-run mode (BS#1998, opt-in).** `DRY_RUN=true` walks the cohort with the real SELECT — same predicate, same paging, same cooperative pause — but calls neither LML nor `enrich`, so it costs nothing and writes nothing. The `scanned` total it reports IS the cohort count. It is opt-in, not the default: this job has written immediately since BS#1433, and both documented run recipes above assume that, so flipping the default would silently turn a re-run of either into a no-op. Unrecognized values throw rather than falling back to "live" — a typo'd `DRY_RUN` that writes when the operator believed it was previewing is the failure worth being loud about.

You can also preview the candidate count in SQL without deploying anything:

```sql
SELECT COUNT(*) FROM wxyc_schema.flowsheet
WHERE metadata_status = 'enriched_no_match'
  AND album_id IS NULL
  AND artist_name IS NOT NULL
  AND add_time >= '2026-07-22T00:00:00Z'::timestamptz;
```

### Incident-cohort run (BS#1998)

The 2026-08-03/04 LML Discogs-breaker flap terminalized **26,387** rows as `enriched_no_match` over ~17 hours. WXYC/Backend-Service#1979 covers only **101** of them — its `add_time >= '2026-06-16T17:53:53Z'` predicate excludes the historical backlog the sibling `flowsheet-metadata-backfill-catchup` container was actually draining at the time. The other **26,286** are this run shape's job.

Those rows are **not selectable by `add_time`** — they span 2004→2026, essentially the whole table. The only thing they share is _when they were frozen_, so BS#1998 added an independent window on `updated_at`:

**What this run shape covers.** Re-measured on prod 2026-08-05 (read-only), the incident window partitions as:

| slice                                                       |   rows |
| ----------------------------------------------------------- | -----: |
| all `enriched_no_match` track rows in the window            | 26,387 |
| — **this job's cohort** (`album_id IS NULL`)                | 26,323 |
| — linked (`album_id IS NOT NULL`), outside this job's guard |     64 |
| non-track rows the base predicate would drop                |      0 |

The 64 linked rows stay out of scope: the `album_id IS NULL` clause in both the SELECT and `reenrichRow`'s UPDATE is the linkage-race guard, and relaxing it here would reintroduce the very race `match_raced` exists to detect. They are nearly all covered elsewhere — 60 fall inside `jobs/flowsheet-linked-reenrichment`'s (BS#1638) frozen `add_time < 2026-06-16` predicate, and 42 of those already have a populated `album_metadata` row, so that job's zero-LML Lane A flips them without a single Discogs call. Re-running it is the right handling. **The residual is 4 rows** (linked, `add_time >= 2026-06-16`, outside both frozen predicates) across ≤12 distinct albums — small enough to fix by hand, and recorded here so it isn't silently inherited as "covered."

```bash
docker run --rm --name flowsheet-reenrichment --env-file .env \
  -e BACKFILL_UPDATED_AFTER_TS='2026-08-04T06:00:00Z' \
  -e BACKFILL_UPDATED_BEFORE_TS='2026-08-04T23:00:00Z' \
  -e DRY_RUN=true \
  <ECR-URI>/flowsheet-reenrichment:<tag> 2>&1 \
  | tee /tmp/flowsheet-reenrichment-incident-$(date +%Y%m%d-%H%M%S).log
```

Drop `DRY_RUN` for the live run. The two pairs are independent axes and compose: supplying an `add_time` bound as well narrows to the intersection, and either pair alone satisfies the at-least-one-bound requirement.

**Why an `updated_at` window doesn't eat its own tail.** Selecting on a mutable column that the drain itself rewrites would normally be a trap. It isn't here, because this job's no-match arm writes nothing (`enrich.ts` change 2): `updated_at` moves only for rows that simultaneously leave the cohort via `metadata_status='enriched_match'`. Matched rows exit; no-match and shed-skipped rows stay exactly where they were. No id-freeze artifact is needed.

**The one real leak:** an _unrelated_ writer touching a cohort row mid-run bumps its `updated_at` past the upper bound and evicts it permanently. `streaming-url-upgrade` is the plausible candidate — it re-queries LML for search-shaped URLs, which is precisely what these rows carry. This under-counts; it never corrupts. Don't run those jobs concurrently, and treat a post-run residual count that fell by more than the run's own `match` total as evidence this happened.

**Pre-flight, in addition to the checklist above:**

1. **LML#1128 must be live in prod**, not just staging. It is what makes a search-leg shed distinguishable from a genuine no-match; without it the run's `still_no_match` total is untrustworthy in exactly the way the incident was. LML deploys prod from the `prod` branch — check `/health`'s `commit_sha` against `prod`'s HEAD, not `main`'s.
2. **Build the partial index for this predicate.** The existing `flowsheet_reenrichment_idx` covers the three base clauses but not the `updated_at` bound; that is fine (it still eliminates the heap scan), so reuse it rather than building a second one-shot index.
3. **Record the dry-run `scanned` count on WXYC/Backend-Service#1998** before authorizing the live run. That number is the frozen cohort size, and the post-run residual is measured against it.

Post-run, read `upstream_unavailable_skipped` alongside `still_no_match` (see below). A non-zero skip count means the run under-covered its cohort and should be repeated once LML is healthy — the skipped rows are untouched and still selectable.

## Pacing & wall-clock estimate

- Sem(1) + TB(20/min): ~12k rows ÷ 20/min ≈ ~10 hours raw rate
- With cooperative-pause deferral during DJ activity (most of every 24h at WXYC): ~12-15 hours realistic

## Kill-switch

```bash
# -t 600 gives the container up to 10 minutes to drain its in-flight row,
# emit the structured `stopped` log line, flush Sentry, and close the DB
# pool. Docker's default 10s grace will SIGKILL before any of that runs;
# the bare `docker stop` form is intentionally not the documented path.
docker stop -t 600 flowsheet-reenrichment
```

The container's SIGTERM handler flips a cooperative-stop flag; the orchestrator checks the flag between rows (not just between batches), so a single in-flight LML lookup is the longest wait. A `step: "stopped"` log line is emitted on graceful break — the runbook's jq filter (below) treats `stopped` and `failed` the same as `finished` so the operator can read the resume cursor.

The signal handler stays attached after the first SIGTERM, so additional SIGTERMs/SIGINTs are idempotent (they just re-flip the already-true flag). If an LML call is wedged past `BACKFILL_LML_PER_CALL_TIMEOUT_MS` and graceful stop isn't progressing, the escape hatch is SIGKILL:

```bash
docker kill flowsheet-reenrichment   # defaults to SIGKILL — force-exit
```

This skips the `finally` arm so Sentry won't flush the last seconds of captures and the DB pool isn't cleanly closed. Only reach for it when graceful stop has demonstrably stuck.

Monitor real-time LML p95 via Sentry trace explorer; stay within +20% of baseline per the BS#994 acceptance criterion.

## Post-run

1. **Source the flip count** from the `finished` / `stopped` / `failed` summary log line. Read `upstream_unavailable_skipped` (BS#1998) alongside `still_no_match`: the latter is a verdict, the former is a question LML never got to ask. A non-zero skip count means the run under-covered its cohort — re-run once LML is healthy; those rows were not written and are still selectable. `-R` (raw input) is required for `fromjson?` to skip non-JSON lines safely — the `console.warn` env-validation lines from lml-fetch / lml-limiter would otherwise crash a default-mode jq invocation:

   ```bash
   # Read from the tee'd file (preferred — survives --rm container removal)
   cat /tmp/flowsheet-reenrichment-*.log | \
     jq -rR 'fromjson? | select(.step=="finished" or .step=="stopped" or .step=="failed") |
       "step=\(.step) dry_run=\(.dry_run) scanned=\(.scanned) flipped=\(.flipped) match_raced=\(.match_raced) still_no_match=\(.still_no_match) upstream_unavailable_skipped=\(.upstream_unavailable_skipped) lml_error=\(.lml_error) db_error=\(.db_error) last_id=\(.last_id)"'
   ```

   If `step=stopped` or `step=failed`, the run did NOT complete the cohort. Re-run it to drain the remainder (the WHERE filter is idempotent against rows the run already flipped); the `last_id` field from the partial run is the resume cursor (the next run's first SELECT will skip everything `id ≤ last_id`). Document the totals from the final completed run as a comment on BS#1433.

2. **Linkage-race audit**: a parallel linkage resolver can flip `album_id` non-null between the orchestrator's SELECT and `reenrichRow`'s UPDATE, which the WHERE guard then skips (counted as `match_raced`). The audit SQL below catches every such orphan — a row with `album_id` non-null AND `metadata_status='enriched_no_match'` AND `artist_name IS NOT NULL` AND `add_time < cutoff`. Without rescue, no automated path revisits these rows; the run also emits one `match_raced_summary` log line with a bounded sample of IDs to cross-reference.

   ```sql
   -- Audit: identify orphans. WHERE must match the drain's WHERE
   -- (artist_name IS NOT NULL) plus album_id IS NOT NULL (the race outcome).
   SELECT id, album_id, artist_name, album_title, add_time
   FROM wxyc_schema.flowsheet
   WHERE metadata_status = 'enriched_no_match'
     AND album_id IS NOT NULL
     AND artist_name IS NOT NULL
     AND add_time < '2026-06-16T17:53:53Z'::timestamptz;
   ```

   **Rescue** (only if the audit returns rows): re-arm them for the nightly backfill cron (`flowsheet-metadata-backfill`), which filters on `metadata_attempt_at IS NULL` and will re-call LML. Setting `metadata_status='pending'` alone is NOT sufficient — the CDC consumer fires only on INSERT, and the backfill cron's WHERE keys on `metadata_attempt_at`. Clear BOTH:

   ```sql
   UPDATE wxyc_schema.flowsheet
      SET metadata_status = 'pending',
          metadata_attempt_at = NULL
    WHERE id = ANY(ARRAY[<audit_ids>]);  -- explicit ID list, not a re-SELECT
   ```

   Do NOT use `WHERE metadata_status='enriched_no_match' AND album_id IS NOT NULL` — that would race a concurrent linkage flip and re-arm rows still being processed. Use the explicit ID list from the audit's output.

3. **Spot-check 20 sample rows that flipped** — verify `discogs_url`, `artwork_url`, `release_year` populated and correct against the live Discogs release.

4. **Drop the one-shot index** once the audit is complete:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS wxyc_schema.flowsheet_reenrichment_idx;
   ```

## Environment variables

| Variable                           | Default                                             | Notes                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKFILL_CUTOFF_TS`               | (required unless `BACKFILL_WINDOW_START_TS` is set) | LML#583 merge timestamp: `2026-06-16T17:53:53Z`. Validated as ISO 8601 + not-in-future at startup. Upper bound (`add_time < cutoff`).                                                                                                                                                                             |
| `BACKFILL_WINDOW_START_TS`         | (optional)                                          | Lower bound (`add_time >= start`) for a scoped regression-window run (BS#1823), e.g. `2026-07-22T00:00:00Z`. Validated as strict ISO 8601 at startup — same rules as `BACKFILL_CUTOFF_TS` except a future value is allowed (it simply selects nothing until reached). At least one of the two bounds is required. |
| `BACKFILL_UPDATED_AFTER_TS`        | (optional)                                          | Lower bound (`updated_at >= start`) for the BS#1998 incident-cohort run, e.g. `2026-08-04T06:00:00Z`. Validated as strict ISO 8601; a future value is allowed (selects nothing). Independent of the `add_time` pair — the two compose.                                                                            |
| `BACKFILL_UPDATED_BEFORE_TS`       | (optional)                                          | Upper bound (`updated_at < end`), e.g. `2026-08-04T23:00:00Z`. Same validation. At least one of the four time bounds is required.                                                                                                                                                                                 |
| `DRY_RUN`                          | `false`                                             | BS#1998. `true` scans the cohort and reports `scanned` with zero LML calls and zero writes. Only exact `true`/`false` accepted — anything else throws rather than silently running live.                                                                                                                          |
| `LIBRARY_METADATA_URL`             | (required)                                          | LML endpoint                                                                                                                                                                                                                                                                                                      |
| `BACKFILL_BATCH_SIZE`              | 100                                                 | Rows per SELECT                                                                                                                                                                                                                                                                                                   |
| `BACKFILL_LML_MAX_CONCURRENT`      | 1                                                   | Semaphore permit count (positive integer)                                                                                                                                                                                                                                                                         |
| `BACKFILL_LML_RATE_PER_MIN`        | 20                                                  | Token bucket rate (positive integer)                                                                                                                                                                                                                                                                              |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS` | 35000                                               | Per-LML-call timeout (ms)                                                                                                                                                                                                                                                                                         |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`   | 60                                                  | Set 0 to disable cooperative pause                                                                                                                                                                                                                                                                                |
| `LIVE_ACTIVITY_PAUSE_MS`           | 30000                                               | Pause duration when DJ activity detected (ms)                                                                                                                                                                                                                                                                     |
| `SENTRY_DSN`                       | (optional)                                          | Sentry error reporting                                                                                                                                                                                                                                                                                            |
