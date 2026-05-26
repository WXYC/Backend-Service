# Runbook: album-level-backfill Phase 3 prod-run (BS#1078)

The album-level-backfill job (BS#1041) is operationally complete on the BS
side; Phase 3 (the actual drain of the ~35,692 unique pending `album_id`s
into `album_metadata`, plus the paired post-pass UPDATE on ~857k linked
flowsheet rows) is gated on LML#370 (per-item cascade-exhaustion hard cap)
and LML#372 (client-cancel propagation into `asyncio.gather`). Both LML
issues closed 2026-05-25 but the LML `prod` deploy is a separate event —
this runbook is the post-deploy execution plan.

## Pre-flight (do NOT skip)

### Verify both LML fixes are live in `prod`

Both must be on LML's `prod` branch, deployed to the LML Railway service
that BS's `LIBRARY_METADATA_URL` points at (NOT the staging instance).

```sh
# Check LML's prod version via the /version endpoint (or equivalent):
curl -s "${LIBRARY_METADATA_URL}/version" | jq .

# Confirm the commit SHA matches a known-good ref that includes both
# LML#370 and LML#372. Cross-reference:
gh issue view 370 --repo WXYC/library-metadata-lookup --json closedAt,timelineItems
gh issue view 372 --repo WXYC/library-metadata-lookup --json closedAt,timelineItems
```

If the `/version` endpoint doesn't exist yet (it's been on the LML wishlist
for a while), fall back to triggering a known-symptom call against LML and
verifying the new behavior:

- **LML#370 verification**: trigger a known cascade-exhaustion item (an
  obscure 1980s European cassette label is the canonical example —
  Jake/Chris will have a current "cascade-bait" list). Verify LML returns
  `status: error` with `timeout: true` after ≤25s wall-clock (the per-item
  cap), not the previous 60+ s symptom.
- **LML#372 verification**: trigger a batch of 10 cascade-bait items
  concurrently via `POST /api/v1/lookup/bulk`, abort the client after 30s,
  confirm via LML's metrics dashboard that the semaphore queue drains
  within 5s of the client abort (not the prior monotonic growth).

If either verification fails, **stop here** — do not start Phase 3. Comment
on BS#1078 with the failing test and re-block on LML.

### Pick a traffic-lull window

Phase 3 holds Discogs slots across ~12h of wall-clock. Schedule for
late-night UTC (00:00–08:00 UTC is ideal) when:

- Cron schedule overlap is minimal. `flowsheet-metadata-backfill-cron`
  fires at `0 6 * * *` UTC by default — start Phase 3 AFTER the daily cron
  has finished (typically by 16:46 UTC if the cron runs 10h45m, but pick a
  later window so you're not co-running). The library `library-etl` and
  `rotation-etl` daily syncs are similarly lighter overnight.
- No active radio show on the WXYC stream. Check the dj-site flowsheet for
  recent `show_start` events.
- BS deploys are quiet. Check `gh run list --workflow="Auto Build & Deploy"
  --branch=main --limit=5` — if a deploy is in flight or imminent, defer.

### Snapshot the starting state

```sh
# Connect to wxyc-ec2's RDS via the standard read-only pattern. Adjust
# DSN to match your local convention.
psql "$WXYC_DB_DSN_READONLY" -c "
  SELECT
    (SELECT COUNT(*) FROM album_metadata) AS album_metadata_rows,
    (SELECT COUNT(*) FROM flowsheet WHERE metadata_status='pending' AND album_id IS NOT NULL) AS linked_pending_residual,
    (SELECT COUNT(DISTINCT album_id) FROM flowsheet WHERE metadata_status='pending' AND album_id IS NOT NULL) AS unique_linked_pending;
"
```

Record these as your T0 snapshot in the BS#1078 comment thread. The
acceptance bullets compare against this state.

## Execution

### Step 1 — Configure the rate

The default is `BACKFILL_BULK_RATE_PER_MIN=1` per the README — explicitly
NOT the aggressive `4` of the 2026-05-25 abort. The README's value is
calibrated for the post-LML-fix queue ceiling. Don't change it unless the
LML team has confirmed a higher rate is safe.

```sh
ssh wxyc-ec2
sudo grep '^BACKFILL_BULK_RATE_PER_MIN' /opt/wxyc/.env
# Expect: BACKFILL_BULK_RATE_PER_MIN=1
# If unset or different, set it:
sudo sed -i.bak '/^BACKFILL_BULK_RATE_PER_MIN=/d; $a BACKFILL_BULK_RATE_PER_MIN=1' /opt/wxyc/.env
```

### Step 2 — Launch the drain

The album-level-backfill job is registered the same way the
flowsheet-metadata-backfill is — via `deploy-base.yml`. Trigger it
manually:

```sh
docker compose --project-name wxyc-backend run --rm album-level-backfill \
  2>&1 | tee /tmp/bs-1078-phase3-$(date +%Y%m%dT%H%MZ).log
```

The job logs structured JSON per batch. Tail it in a second SSH session:

```sh
tail -f /tmp/bs-1078-phase3-*.log | jq -r 'select(.step=="batch_done")'
```

### Step 3 — Abort criterion

**If any single batch exceeds 25 s wall-clock, abort.** That's the early
recurrence signal — it means the per-item cap from LML#370 isn't engaging
(or worse, the queue is growing again because LML#372 isn't propagating
cancellation).

Each `batch_done` record includes `wall_clock_ms`. The watchdog:

```sh
# In a third SSH session, alarm when any batch exceeds 25000ms:
tail -f /tmp/bs-1078-phase3-*.log \
  | jq -r 'select(.step=="batch_done" and .wall_clock_ms>25000) | "ABORT: batch_index=\(.batch_index) wall_clock_ms=\(.wall_clock_ms)"' \
  | head -1
```

If that one-shot watchdog fires, kill the drain container (`docker stop
<container>`) and start the deeper investigation per BS#1078 body. Don't
restart the drain — figure out what regressed first.

### Step 4 — Watch for the first 20 batches

The first 20 batches are the canary. If they all complete in <25s with
<5% per-item errors, the run is healthy and you can let it finish
unattended. The job's loop survives per-batch failures so a transient hiccup
mid-run won't kill it.

```sh
grep '"step":"batch_done"' /tmp/bs-1078-phase3-*.log \
  | jq -s 'sort_by(.batch_index) | .[:20] | {
      batches: length,
      max_wall_ms: ([.[].wall_clock_ms] | max),
      total_errors: ([.[].lml_error // 0] | add),
      total_scanned: ([.[].scanned] | add)
    }'
```

### Step 5 — Post-pass UPDATE

After all batches complete (`linked_pending_residual` per the SQL probe in
pre-flight should be approaching 0), the post-pass UPDATE that flips the
~857k linked-pending flowsheet rows runs as part of the job's own
shutdown. It's NOT a separate manual step — but verify it completed:

```sh
grep '"step":"post_pass_update_done"' /tmp/bs-1078-phase3-*.log
```

If that record is missing and the job exited cleanly, the SQL UPDATE either
didn't run or crashed mid-flight. Re-run with `--phase=post-pass-only` (the
job exposes that flag per BS#1041) — it's idempotent.

## Acceptance verification

Re-snapshot the same SQL from pre-flight and compare against T0:

| Metric | Pre-flight | Expected post-run | Acceptance |
|---|---|---|---|
| `album_metadata` rows | T0 value | T0 + ~30k | growth ≥ 25k → ✅ |
| `linked_pending_residual` | T0 value (~857k) | ≈ 0 | residual < 10k → ✅ |
| `unique_linked_pending` | T0 value (~35,692) | ≈ 0 | residual < 1k → ✅ |

The "residual < N" tolerances allow for:
- Cascade-exhaustion items that LML#370 explicitly bounces to the per-row
  drain cron (flowsheet-metadata-backfill); these stay `pending` here but
  are picked up by the daily cron.
- Rows added concurrently during the drain by live worker writes.

Post in BS#1078 comment thread:

- Start/end timestamps (UTC)
- Number of batches run
- Max batch wall_clock_ms
- T0 → T1 deltas for the three metrics above
- Any abort + restart events
- Final state of `album_level_backfill_journal` or equivalent if such a
  table exists (idempotency proof)

## What to skip if a partial run already shipped

If the 2026-05-25 partial run already wrote some `album_metadata` rows
(~290 per BS#1078), the job's `INSERT … ON CONFLICT DO NOTHING` shape
means re-running is safe — duplicates are no-ops. The `linked_pending`
state is the load-bearing measure for completion; re-running until that
reaches ~0 is the correct contract.

## Out of scope

- Migration of the BS-side cron's `BACKFILL_LML_PER_CALL_TIMEOUT_MS` (see
  `ops-lml-cron-revalidation.md` — that's BS#1064's runbook).
- Any change to LML's Discogs slot count or LML's queue behavior — both
  are upstream concerns; this runbook is BS-side execution only.
