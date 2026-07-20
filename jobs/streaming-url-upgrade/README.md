# streaming-url-upgrade

One-shot remediation for BS#1672. Re-queries LML for every `album_metadata` / `flowsheet` row whose `spotify_url` or `bandcamp_url` was persisted as a provider **search** URL, then overwrites ONLY the still-search-shaped columns with the verified link LML now returns. **Dry-run is the default; writes require `--execute`.**

## Problem

When LML can't verify a direct provider link, the enrichment worker persists a **search** URL — the byte-identical output of `@wxyc/metadata`'s `synthesizeSearchUrls` — as a fallback:

- Spotify: `https://open.spotify.com/search/<query>`
- Bandcamp: `https://bandcamp.com/search?q=<query>`

(Apple is never persisted as a search URL — BS#1192 synthesizes no Apple fallback — so it is out of scope here.)

Once LML's streaming-availability drain lands a verified link for that release, BS never re-queries, so the search-URL placeholder becomes **permanent**. This job re-runs the same lookup and upgrades the placeholder to the verified link, one column at a time.

**Candidate predicate** (identical in the job's phase-start COUNT, its batch SELECT, and the scope-confirm SQL below):

```
spotify_url LIKE 'https://open.spotify.com/search/%'  OR  bandcamp_url LIKE 'https://bandcamp.com/search?q=%'
```

A row is a candidate if **either** column is search-shaped. One LML lookup can upgrade **both** columns on that row via two independent guarded UPDATEs.

```sql
-- Confirm scope BEFORE running (org data-safety rule). Same predicates the job uses.
SELECT COUNT(*) FROM wxyc_schema.album_metadata am
LEFT JOIN wxyc_schema.library l ON l.id = am.album_id
LEFT JOIN wxyc_schema.artists a ON l.artist_id = a.id
WHERE (am.spotify_url LIKE 'https://open.spotify.com/search/%'
       OR am.bandcamp_url LIKE 'https://bandcamp.com/search?q=%')
  AND COALESCE(a.artist_name, l.artist_name) IS NOT NULL;

SELECT COUNT(*) FROM wxyc_schema.flowsheet f
WHERE f.entry_type = 'track'
  AND (f.spotify_url LIKE 'https://open.spotify.com/search/%'
       OR f.bandcamp_url LIKE 'https://bandcamp.com/search?q=%')
  AND f.artist_name IS NOT NULL
  AND f.add_time >= '2026-05-01';
```

Per candidate the job runs up to TWO LML lookups (artist + album + song, `extended: true`): the second fires only when the first returned no verified URL for **any** still-pending column, after `UPGRADE_SECOND_PASS_DELAY_MS`, to catch LML's eventual-consistency streaming fill. Repeat (artist, album, track) triples are served from an in-run cache.

**Never-downgrade guard**: each UPDATE carries `<column> LIKE '<search-prefix>%'` in its WHERE. If a verified link appeared between SELECT and UPDATE, the UPDATE matches 0 rows (counted `skipped_not_search`) — a verified link is never overwritten, and a search URL is never written over a search URL (`extractStreamingUrls` coerces still-search-shaped LML output to null).

## Scope

- **album_metadata**: full table.
- **flowsheet**: `entry_type = 'track'` since `2026-05-01` (`UPGRADE_FLOWSHEET_SINCE`). The 1.34M deep tail before that date is deferred.
- **Services**: `spotify` + `bandcamp`. YouTube columns are schema-ready but **excluded** until LML#833 lands its YouTube drain. SoundCloud dropped (0 verified links in the corpus).

## Gate — DO NOT `--execute` yet

The write-run is gated on both provider drains completing in LML production:

- **LML#831** — Spotify streaming-URL drain (OPEN)
- **LML#832** — Bandcamp streaming-URL drain (OPEN)

Until both drain, LML still returns the same search-shaped fallbacks and the re-query is a no-op that just re-confirms the placeholder. Build / typecheck / **dry-run** are fine now; `--execute` waits for the gate.

## Pre-flight checklist

1. **LML#831 + LML#832 drained to LML production.** A dry-run's `would_upgrade` count doubling as a live probe is the cheap way to confirm links are now verifiable before `--execute`.

2. **Sibling cron is stopped.** All backfill/upgrade jobs share the `UPGRADE_LML_*` token bucket AND LML's global Discogs ceiling. Concurrent runs trip the BS#994 outage pattern.

   ```bash
   docker ps -a --filter name=flowsheet-metadata-backfill-cron --format '{{.Status}}'
   # Must show: Exited (running is not)
   ```

3. **Run off-peak, outside the 06:00 UTC flood window** (coordinate with BS#1591). The cooperative pause defers batches while DJs are active, but scheduling around the flood is still on the operator.

4. **Optional, recommended for the flowsheet phase: build the partial index out-of-band.** The flowsheet WHERE has no covering index; without one each batch SELECT degrades toward a heap scan as the cursor advances.

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS flowsheet_search_url_upgrade_idx
     ON wxyc_schema.flowsheet (id)
     WHERE entry_type = 'track'
       AND artist_name IS NOT NULL
       AND (spotify_url LIKE 'https://open.spotify.com/search/%'
            OR bandcamp_url LIKE 'https://bandcamp.com/search?q=%');
   ```

   `CONCURRENTLY` takes only a `ShareUpdateExclusiveLock`, so DJs keep inserting while it builds. Drop it after the run (see Post-run). `album_metadata` needs no index.

5. **Snapshot the verified rows** so the post-run never-downgrade spot-check is a mechanical diff:

   ```sql
   CREATE TABLE wxyc_schema.upgrade_prerun_fs AS
     SELECT id, spotify_url, bandcamp_url FROM wxyc_schema.flowsheet
     WHERE spotify_url IS NOT NULL OR bandcamp_url IS NOT NULL;
   CREATE TABLE wxyc_schema.upgrade_prerun_am AS
     SELECT album_id, spotify_url, bandcamp_url FROM wxyc_schema.album_metadata
     WHERE spotify_url IS NOT NULL OR bandcamp_url IS NOT NULL;
   ```

## Run procedure

```bash
# 1. Build & push image (the Dockerfile.<target> filename IS the deploy registration).
gh workflow run deploy-manual.yml --ref main \
  -f target=streaming-url-upgrade -f version=latest

# 2. SSH to EC2. Tee logs to a file BEFORE relying on `docker logs` —
# `--rm` removes the container on exit and the structured summary line is
# unrecoverable afterwards. `--name` is load-bearing for the kill-switch.
ssh wxyc-ec2

# 3. DRY-RUN FIRST (the default — no flag needed). Full paced LML sweep,
# candidate + would_upgrade counts, ZERO writes.
docker run --rm --name streaming-url-upgrade --env-file .env \
  <ECR-URI>/streaming-url-upgrade:<tag> 2>&1 \
  | tee /tmp/streaming-url-upgrade-dryrun-$(date +%Y%m%d-%H%M%S).log

# 4. Review the dry-run summary (see Post-run jq), then — ONLY after the
# LML#831/#832 gate — execute:
docker run --rm --name streaming-url-upgrade --env-file .env \
  <ECR-URI>/streaming-url-upgrade:<tag> --execute 2>&1 \
  | tee /tmp/streaming-url-upgrade-$(date +%Y%m%d-%H%M%S).log
```

For a bounded pilot, add `-e UPGRADE_MAX_ROWS_PER_TABLE=50`.

> **Env-var read timing**: `lml-fetch.ts` reads `UPGRADE_LML_PER_CALL_TIMEOUT_MS` and `lml-limiter.ts` reads `UPGRADE_LML_MAX_CONCURRENT` / `UPGRADE_LML_RATE_PER_MIN` at module load. Pass env vars via `--env-file`/`-e` so they're visible to PID 1; exporting inside the container after start is silently ignored.

## Pacing & wall-clock estimate

Serial rows behind Sem(1) + TB(20/min). A first-pass hit costs 1 token; an unresolved candidate costs 2 tokens + the 15 s second-pass delay, so throughput ranges ~7–20 candidates/min depending on hit rate. Size the run from the dry-run's candidate counts before `--execute`.

## Kill-switch

```bash
# Up to 10 min grace so the in-flight row drains, the structured `stopped`
# line (with resume cursors) is emitted, Sentry flushes, and the DB pool
# closes. Docker's default 10 s grace would SIGKILL first.
docker stop -t 600 streaming-url-upgrade
```

The SIGTERM handler flips a cooperative-stop flag checked between rows (and inside every sleep), so a single in-flight LML lookup is the longest wait. Repeated SIGTERM/SIGINT are idempotent; the escape hatch for a wedged LML call is `docker kill` (SIGKILL — skips the `finally` arm, so Sentry may lose the last seconds).

## Resumability & idempotency

- Upgraded columns drop out of the WHERE (no longer search-shaped), so plain re-runs are always safe and only re-visit still-search-shaped columns.
- To skip already-swept rows after a `stopped`/`failed` run, pass the summary line's per-phase `last_id` cursors: `-e UPGRADE_ALBUM_AFTER_ID=<n> -e UPGRADE_FLOWSHEET_AFTER_ID=<n>`. A cursored resume also skips any rows counted `lml_error` below the cursor — those still match the predicate, so a final plain re-run WITHOUT cursors picks them back up.
- Never-downgrade is enforced in the UPDATE's WHERE (`... AND <column> LIKE '<search-prefix>%'`), not just app logic — a verified URL that appears mid-run makes the UPDATE match 0 rows (counted `skipped_not_search`).

## Post-run

1. **Source the counts** from the `finished` / `stopped` / `failed` summary line (`-R` + `fromjson?` skips the non-JSON env-validation warns). Each phase carries per-service `spotify` / `bandcamp` sub-objects:

   ```bash
   cat /tmp/streaming-url-upgrade-*.log | \
     jq -rR 'fromjson? | select(.step=="finished" or .step=="stopped" or .step=="failed") |
       "step=\(.step) dry_run=\(.dry_run)\n" +
       "am:  cand=\(.album_metadata.candidates) scanned=\(.album_metadata.scanned) lml_err=\(.album_metadata.lml_error) last_id=\(.album_metadata.last_id)\n" +
       "  spotify:  upgraded=\(.album_metadata.spotify.upgraded) would=\(.album_metadata.spotify.would_upgrade) still_search=\(.album_metadata.spotify.still_search) skipped=\(.album_metadata.spotify.skipped_not_search) db_err=\(.album_metadata.spotify.db_error)\n" +
       "  bandcamp: upgraded=\(.album_metadata.bandcamp.upgraded) would=\(.album_metadata.bandcamp.would_upgrade) still_search=\(.album_metadata.bandcamp.still_search) skipped=\(.album_metadata.bandcamp.skipped_not_search) db_err=\(.album_metadata.bandcamp.db_error)\n" +
       "fs:  cand=\(.flowsheet.candidates) scanned=\(.flowsheet.scanned) lml_err=\(.flowsheet.lml_error) last_id=\(.flowsheet.last_id)\n" +
       "  spotify:  upgraded=\(.flowsheet.spotify.upgraded) would=\(.flowsheet.spotify.would_upgrade) still_search=\(.flowsheet.spotify.still_search) skipped=\(.flowsheet.spotify.skipped_not_search) db_err=\(.flowsheet.spotify.db_error)\n" +
       "  bandcamp: upgraded=\(.flowsheet.bandcamp.upgraded) would=\(.flowsheet.bandcamp.would_upgrade) still_search=\(.flowsheet.bandcamp.still_search) skipped=\(.flowsheet.bandcamp.skipped_not_search) db_err=\(.flowsheet.bandcamp.db_error)"'
   ```

   Document the totals as a comment on BS#1672.

2. **Never-downgrade spot-check** (acceptance criterion): diff against the pre-run snapshot — a verified (non-search) URL must never have changed. Both counts must be 0, then drop the snapshot tables.

   ```sql
   SELECT COUNT(*) FROM wxyc_schema.upgrade_prerun_fs s
   JOIN wxyc_schema.flowsheet f USING (id)
   WHERE (s.spotify_url  NOT LIKE 'https://open.spotify.com/search/%' AND f.spotify_url  IS DISTINCT FROM s.spotify_url)
      OR (s.bandcamp_url NOT LIKE 'https://bandcamp.com/search?q=%'  AND f.bandcamp_url IS DISTINCT FROM s.bandcamp_url);

   SELECT COUNT(*) FROM wxyc_schema.upgrade_prerun_am s
   JOIN wxyc_schema.album_metadata a USING (album_id)
   WHERE (s.spotify_url  NOT LIKE 'https://open.spotify.com/search/%' AND a.spotify_url  IS DISTINCT FROM s.spotify_url)
      OR (s.bandcamp_url NOT LIKE 'https://bandcamp.com/search?q=%'  AND a.bandcamp_url IS DISTINCT FROM s.bandcamp_url);

   DROP TABLE wxyc_schema.upgrade_prerun_fs, wxyc_schema.upgrade_prerun_am;
   ```

3. **Drop the one-shot index**:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS wxyc_schema.flowsheet_search_url_upgrade_idx;
   ```

## Environment variables

| Variable                          | Default      | Notes                                                                     |
| --------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`            | (required)   | LML endpoint                                                              |
| `UPGRADE_BATCH_SIZE`              | 100          | Rows per SELECT                                                           |
| `UPGRADE_MAX_ROWS_PER_TABLE`      | 0            | 0 = unlimited; positive cap bounds a pilot run per phase                  |
| `UPGRADE_SECOND_PASS_DELAY_MS`    | 15000        | Delay before the second lookup (eventual-consistency fill); 0 = immediate |
| `UPGRADE_FLOWSHEET_SINCE`         | `2026-05-01` | `YYYY-MM-DD` floor on flowsheet `add_time`; the deep tail is deferred     |
| `UPGRADE_ALBUM_AFTER_ID`          | 0            | Resume cursor for the album_metadata phase                                |
| `UPGRADE_FLOWSHEET_AFTER_ID`      | 0            | Resume cursor for the flowsheet phase                                     |
| `UPGRADE_LML_MAX_CONCURRENT`      | 1            | Semaphore permit count (shared knob across the backfill/upgrade family)   |
| `UPGRADE_LML_RATE_PER_MIN`        | 20           | Token bucket rate                                                         |
| `UPGRADE_LML_PER_CALL_TIMEOUT_MS` | 35000        | Per-LML-call timeout (ms)                                                 |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`  | 60           | Set 0 to disable the cooperative pause                                    |
| `LIVE_ACTIVITY_PAUSE_MS`          | 30000        | Pause duration when DJ activity detected (ms)                             |
| `SENTRY_DSN`                      | (optional)   | Sentry error reporting                                                    |

CLI flags: `--execute` (write mode), `--dry-run` (explicit no-op, the default; passing both fails fast).
