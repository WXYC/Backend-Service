# streaming-url-remediation

One-shot host remediation for BS#1715. Scans `album_metadata` + `flowsheet` for rows whose stored `spotify_url` is not a Spotify host (or `apple_music_url` is not an Apple host) and rewrites each row so every column holds only a host-correct value — relocating a real link that landed in the wrong slot and nulling an unrecoverable foreign value so the read path synthesizes the `open.spotify.com/search/…` fallback. **Pure local host arbitration — no LML.** Batched VALUES-join UPDATE + `ANALYZE` per table. **Dry-run is the default; writes require `--execute`.**

## Problem

BS#1710 established that LML's `results[].artwork.spotify_url` sometimes literally stores a **non-Spotify** URL (Deezer, Apple, Bandcamp, Tidal). BS persisted it verbatim, and iOS binds `spotify_url` to a hardwired green "Spotify" button — so a mislabeled row opens the wrong provider. Two upstream fixes stop the bleeding:

- **#1712 — ingestion guard** (merged): the enrichment/write path now rejects a value whose host doesn't match its column, so no _new_ mislabeled row is persisted.
- **#1714 — read-time serve-seam guard** (PR #1720): `/proxy/metadata` and the flowsheet read paths re-check the host at serve time and suppress a foreign value, so live reads are already correct.

But BS persistence is **fill-only**: neither guard rewrites the rows that were persisted _before_ the guard shipped. Those keep their foreign-host value forever. This job is the durable data fix — the one place that actually overwrites the historical pollution.

## Distinction from `streaming-url-upgrade` (BS#1672)

The sibling `jobs/streaming-url-upgrade` (structural donor for this job's orchestrator) re-queries LML to upgrade **search-shaped** URLs (correct provider, search-page placeholder) to verified direct links. This job handles **wrong-provider host** pollution (a Deezer/Apple URL sitting in the `spotify_url` column) and needs **no LML** — the correct value is already present in the row (mis-filed in the other slot) or nowhere. The two jobs' nets never overlap: a spotify-search URL _is_ spotify-hosted (this job's net skips it), and a foreign-host URL is _not_ search-shaped (the upgrade job's net skips it).

## The fix (pure arbiter)

Every candidate row is rewritten through `computeStreamingUrlFix` (`transform.ts`) using the `@wxyc/lml-client` host guards (`isSpotifyUrl` / `isAppleMusicUrl`):

- `spotify_url` keeps its value iff it is a Spotify host; else it adopts `apple_music_url`'s value iff _that_ is a Spotify host (a Spotify link mis-filed in the apple slot); else it becomes null.
- `apple_music_url` is the mirror image.

| before spotify      | before apple         | after spotify        | after apple         | case                       |
| ------------------- | -------------------- | -------------------- | ------------------- | -------------------------- |
| `music.apple.com/X` | null                 | null                 | `music.apple.com/X` | relocate to correct slot   |
| `music.apple.com/X` | `music.apple.com/Y`  | null                 | `music.apple.com/Y` | keep real apple, drop dupe |
| `deezer.com/X`      | null                 | null                 | null                | unrecoverable → clear      |
| `deezer.com/X`      | `music.apple.com/Y`  | null                 | `music.apple.com/Y` | clear foreign, keep apple  |
| null                | `open.spotify.com/X` | `open.spotify.com/X` | null                | relocate the other way     |

A null result is deliberate: the read path synthesizes an `open.spotify.com/search/…` fallback for a null `spotify_url`, so nulling a foreign value restores correct behavior rather than leaving a dead button.

## Candidate net

The coarse SQL net — shared verbatim by the phase-start COUNT, the batch SELECT, and the post-run verification so the three can never drift:

```
(spotify_url IS NOT NULL AND spotify_url NOT ILIKE '%spotify.com%')
OR (apple_music_url IS NOT NULL AND apple_music_url NOT ILIKE '%apple.com%')
```

Every net-matched row necessarily changes (a value that fails `NOT ILIKE '%spotify.com%'` can never be a Spotify host), so a complete `--execute` run leaves **exactly zero candidates** — which the post-run verification asserts (acceptance criterion 4).

The substrings only _bound the scan_; the per-row guard is the true arbiter within the net. The net intentionally does **not** catch suffix-spoofs like `spotify.com.evil.example` (which _contain_ the substring) — those are absent from prod historically and are handled at read time by #1714, so they are out of scope here.

### Scope

- **album_metadata**: full table.
- **flowsheet**: full table. No `entry_type` / `add_time` filter — the net is self-limiting (only enriched track rows ever got a `spotify_url`), and this is a correctness fix, so the deep tail is _not_ deferred (unlike the LML-budget-bound `streaming-url-upgrade`).

```sql
-- Confirm scope BEFORE running (org data-safety rule). Same predicate the job uses.
SELECT COUNT(*) FROM wxyc_schema.album_metadata
WHERE (spotify_url IS NOT NULL AND spotify_url NOT ILIKE '%spotify.com%')
   OR (apple_music_url IS NOT NULL AND apple_music_url NOT ILIKE '%apple.com%');

SELECT COUNT(*) FROM wxyc_schema.flowsheet
WHERE (spotify_url IS NOT NULL AND spotify_url NOT ILIKE '%spotify.com%')
   OR (apple_music_url IS NOT NULL AND apple_music_url NOT ILIKE '%apple.com%');
```

As of 2026-07-20 the ticket's `NOT LIKE '%spotify.com%'` figures were **68,465** flowsheet rows and **3,935** album_metadata rows. The job's net uses `NOT ILIKE` (case-insensitive), a subset of `NOT LIKE`, so the dry-run count may differ marginally if any host was persisted with non-lowercase casing; in practice hosts are lowercase and the counts match.

## Gate

`--execute` depends on **#1712 (ingestion guard) merged and deployed to prod**. #1712 is merged; the deploy matters only for the write run, so that a row this job heals isn't immediately re-polluted by a live writer still on the old code. Build / typecheck / **dry-run** are safe at any time.

## Pre-flight checklist

1. **#1712 is live in prod** (confirm the running backend image post-dates the merge). Only gates `--execute`.

2. **No sibling bulk job is writing the same tables.** This job takes no LML tokens, but a concurrent `flowsheet-metadata-backfill` / `album-level-backfill` / `streaming-url-upgrade` write pass churns the same heap pages.

   ```bash
   docker ps -a --filter name=flowsheet-metadata-backfill-cron --format '{{.Status}}'   # Must show Exited
   ```

3. **Run off-peak, outside the 06:00 UTC flood window.** The cooperative pause defers batches while DJs are active, but scheduling around the flood is still on the operator.

4. **Optional, recommended for the flowsheet phase: build the partial index out-of-band.** The flowsheet net has no covering index; without one each batch SELECT degrades toward a heap scan as the cursor advances.

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS flowsheet_streaming_host_remediation_idx
     ON wxyc_schema.flowsheet (id)
     WHERE (spotify_url IS NOT NULL AND spotify_url NOT ILIKE '%spotify.com%')
        OR (apple_music_url IS NOT NULL AND apple_music_url NOT ILIKE '%apple.com%');
   ```

   `CONCURRENTLY` takes only a `ShareUpdateExclusiveLock`, so DJs keep inserting while it builds. Drop it after the run (see Post-run). `album_metadata` is small enough to need no index.

5. **Snapshot the affected rows** so the post-run "never touched a correct row" spot-check is a mechanical diff:

   ```sql
   CREATE TABLE wxyc_schema.remediation_prerun_fs AS
     SELECT id, spotify_url, apple_music_url FROM wxyc_schema.flowsheet
     WHERE spotify_url IS NOT NULL OR apple_music_url IS NOT NULL;
   CREATE TABLE wxyc_schema.remediation_prerun_am AS
     SELECT album_id, spotify_url, apple_music_url FROM wxyc_schema.album_metadata
     WHERE spotify_url IS NOT NULL OR apple_music_url IS NOT NULL;
   ```

## Run procedure

```bash
# 1. Build & push image (the Dockerfile.<target> filename IS the deploy registration).
gh workflow run deploy-manual.yml --ref main \
  -f target=streaming-url-remediation -f version=latest

# 2. SSH to EC2. Tee logs to a file BEFORE relying on `docker logs` — `--rm`
# removes the container on exit and the structured summary line is unrecoverable
# afterwards. `--name` is load-bearing for the kill-switch.
ssh wxyc-ec2

# 3. DRY-RUN FIRST (the default — no flag needed). Full paged scan, candidate +
# changed counts + a before→after sample, ZERO writes.
docker run --rm --name streaming-url-remediation --env-file .env \
  <ECR-URI>/streaming-url-remediation:<tag> 2>&1 \
  | tee /tmp/streaming-url-remediation-dryrun-$(date +%Y%m%d-%H%M%S).log

# 4. Review the dry-run summary (see Post-run jq), then execute:
docker run --rm --name streaming-url-remediation --env-file .env \
  <ECR-URI>/streaming-url-remediation:<tag> --execute 2>&1 \
  | tee /tmp/streaming-url-remediation-$(date +%Y%m%d-%H%M%S).log
```

For a bounded pilot, add `-e REMEDIATION_MAX_ROWS_PER_TABLE=5000` (a positive cap skips the post-run verification, since residual candidates are expected).

## Kill-switch

```bash
# Up to 10 min grace so the in-flight batch drains, the structured `stopped`
# line (with resume cursors) is emitted, Sentry flushes, and the DB pool closes.
# Docker's default 10 s grace would SIGKILL first.
docker stop -t 600 streaming-url-remediation
```

The SIGTERM handler flips a cooperative-stop flag checked between batches (and inside every sleep), so one in-flight batch UPDATE is the longest wait. Repeated SIGTERM/SIGINT are idempotent; the escape hatch for a wedged statement is `docker kill` (SIGKILL — skips the `finally` arm, so Sentry may lose the last seconds).

## Resumability & idempotency

- A fixed row is host-correct and drops out of the net, so plain re-runs are always safe and only re-visit still-mislabeled rows.
- The resume cursor advances only **after** a page's write commits, so a mid-run write failure never strands unwritten rows behind the logged cursor. A re-run from the previous cursor re-selects them.
- To skip already-swept rows after a `stopped`/`failed` run, pass the summary line's per-phase `last_id` cursors: `-e REMEDIATION_ALBUM_AFTER_ID=<n> -e REMEDIATION_FLOWSHEET_AFTER_ID=<n>`. A final plain re-run WITHOUT cursors then re-covers anything skipped below the cursor by an earlier failure.

## Post-run

1. **Source the counts** from the `finished` / `stopped` / `failed` summary line (`-R` + `fromjson?` skips the non-JSON env-validation warns):

   ```bash
   cat /tmp/streaming-url-remediation-*.log | \
     jq -rR 'fromjson? | select(.step=="finished" or .step=="stopped" or .step=="failed") |
       "step=\(.step) dry_run=\(.dry_run)\n" +
       "am:  cand=\(.album_metadata.candidates) scanned=\(.album_metadata.scanned) changed=\(.album_metadata.changed) written=\(.album_metadata.written) remaining=\(.album_metadata.remaining) last_id=\(.album_metadata.last_id)\n" +
       "     spotify_cleared=\(.album_metadata.spotify_cleared) spotify_recovered=\(.album_metadata.spotify_recovered) apple_cleared=\(.album_metadata.apple_cleared) apple_recovered=\(.album_metadata.apple_recovered)\n" +
       "fs:  cand=\(.flowsheet.candidates) scanned=\(.flowsheet.scanned) changed=\(.flowsheet.changed) written=\(.flowsheet.written) remaining=\(.flowsheet.remaining) last_id=\(.flowsheet.last_id)\n" +
       "     spotify_cleared=\(.flowsheet.spotify_cleared) spotify_recovered=\(.flowsheet.spotify_recovered) apple_cleared=\(.flowsheet.apple_cleared) apple_recovered=\(.flowsheet.apple_recovered)"'
   ```

   After a full `--execute` run, `remaining` must be `0` on both phases (the verification also fails the run's exit code if not). Document the totals as a comment on BS#1715.

2. **"Never touched a correct row" spot-check** — a row whose stored value was already host-correct must be unchanged; only mislabeled rows may differ:

   ```sql
   SELECT COUNT(*) FROM wxyc_schema.remediation_prerun_fs s
   JOIN wxyc_schema.flowsheet f USING (id)
   WHERE (s.spotify_url ILIKE '%spotify.com%'  AND f.spotify_url      IS DISTINCT FROM s.spotify_url)
      OR (s.apple_music_url ILIKE '%apple.com%' AND f.apple_music_url IS DISTINCT FROM s.apple_music_url);

   SELECT COUNT(*) FROM wxyc_schema.remediation_prerun_am s
   JOIN wxyc_schema.album_metadata a USING (album_id)
   WHERE (s.spotify_url ILIKE '%spotify.com%'  AND a.spotify_url      IS DISTINCT FROM s.spotify_url)
      OR (s.apple_music_url ILIKE '%apple.com%' AND a.apple_music_url IS DISTINCT FROM s.apple_music_url);

   DROP TABLE wxyc_schema.remediation_prerun_fs, wxyc_schema.remediation_prerun_am;
   ```

   Both counts must be 0, then drop the snapshot tables.

3. **Drop the one-shot index** (if built):

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS wxyc_schema.flowsheet_streaming_host_remediation_idx;
   ```

## Environment variables

| Variable                         | Default    | Notes                                                                               |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `REMEDIATION_BATCH_SIZE`         | 5000       | Rows per SELECT / VALUES-join UPDATE (bulk-update playbook default)                 |
| `REMEDIATION_MAX_ROWS_PER_TABLE` | 0          | 0 = full table; a positive cap bounds a pilot run per phase and skips verification  |
| `REMEDIATION_UPDATE_TIMEOUT_MS`  | 300000     | `SET LOCAL statement_timeout` around each batch UPDATE                              |
| `REMEDIATION_ANALYZE_TIMEOUT_MS` | 300000     | `SET LOCAL statement_timeout` around each post-pass `ANALYZE`                       |
| `REMEDIATION_SAMPLE_SIZE`        | 20         | Before→after rows carried in each phase summary; 0 to omit                          |
| `REMEDIATION_ALBUM_AFTER_ID`     | 0          | Resume cursor for the album_metadata phase                                          |
| `REMEDIATION_FLOWSHEET_AFTER_ID` | 0          | Resume cursor for the flowsheet phase                                               |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS` | 60         | Set 0 to disable the cooperative pause                                              |
| `LIVE_ACTIVITY_PAUSE_MS`         | 30000      | Pause duration when DJ activity detected (ms)                                       |
| `DB_STATEMENT_TIMEOUT_MS`        | 300000     | Connection-level timeout (Dockerfile); the batch scans need more than the API's 5 s |
| `DB_SYNCHRONOUS_COMMIT`          | off        | Async commit (Dockerfile); safe because an unwritten row still matches the net      |
| `SENTRY_DSN`                     | (optional) | Sentry error reporting                                                              |

CLI flags: `--execute` (write mode), `--dry-run` (explicit no-op, the default; passing both fails fast).
