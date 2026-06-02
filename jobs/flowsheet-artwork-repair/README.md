# @wxyc/flowsheet-artwork-repair

One-shot drain (BS#1209): re-resolve LML artwork for rows stranded by the LML#408 `_resolve_fallback_artwork` bug (fixed in LML#409, deployed to prod 2026-05-29).

## What it does

Two-phase walk over the two populations the bug left behind:

1. **Free-form residue** — `flowsheet.metadata_status = 'enriched_match' AND artwork_url IS NULL AND album_id IS NULL`. The enrichment-worker landed a 10-col UPDATE with `artwork_url = NULL` and flipped the status to `enriched_match`. We re-query LML and write the same 10 cols. `metadata_status` is read-only — the drain never flips it.
2. **Linked residue** — `album_metadata.artwork_url IS NULL`. The worker UPSERTed with `artwork_url = NULL`. We re-query LML and UPSERT the same 10 cols, race-guarded by `setWhere: updated_at < NOW()`. No flowsheet write — the read-path `COALESCE` join over `album_metadata` picks the fix up automatically.

## Run procedure

Pre-flight: post the two scoping counts on BS#1209 as a comment before launching, then verify the go/no-go floor.

```sql
-- (a) Free-form residue, row-level count
SELECT COUNT(*) FROM wxyc_schema.flowsheet
WHERE metadata_status = 'enriched_match'
  AND artwork_url IS NULL
  AND album_id IS NULL;

-- (b) Linked residue, album-level dedup count
SELECT COUNT(DISTINCT am.album_id)
FROM wxyc_schema.album_metadata am
WHERE am.artwork_url IS NULL;
```

If either count exceeds ~10k, consider switching to the LML bulk endpoint (LML#368) — at the default `BACKFILL_LML_RATE_PER_MIN=20`, the per-row path drains ~1200/h, so 10k rows = ~8h. Bulk compresses materially. As of the initial implementation, single-row is the default; bulk-swap follow-up is a separate ticket.

Go/no-go: the rolling 1h `enriched_match → non-null artwork_url` rate from the `enrichment.consumer.tick` Sentry transactions must clear **≥ 90 %** (excluding rows whose fresh LML call genuinely returns no artwork). Pre-LML#409 steady state was ~24 %; the deploy should push that toward 100 % with the long tail being legitimate no-cover-anywhere releases. If the floor doesn't hold after a few hours post-deploy, the drain should wait — the LML fix isn't covering the population we expected.

```bash
# 1. Build & push image via GitHub Actions
gh workflow run deploy-manual.yml \
  --ref main \
  -f target=flowsheet-artwork-repair \
  -f version=latest

# 2. SSH to BS EC2 (see MEMORY.md / reference_ec2_access.md)
ssh wxyc-ec2

# 3. Optional: stop sibling drains so they don't compete for LML rate
docker stop flowsheet-metadata-backfill-cron

# 4. Run the drain
docker run --rm --env-file .env <image> 2>&1 | tee /tmp/flowsheet-artwork-repair.log

# 5. Sanity check
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) FROM wxyc_schema.flowsheet
  WHERE metadata_status='enriched_match' AND artwork_url IS NULL AND album_id IS NULL;
"
psql "$DATABASE_URL" -c "
  SELECT COUNT(DISTINCT album_id) FROM wxyc_schema.album_metadata WHERE artwork_url IS NULL;
"
```

After one full run, both counts should drop to the LML-true-no-match floor.

## Env knobs

| Variable                             | Default | Meaning                                                                                                                                                      |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKFILL_LML_RATE_PER_MIN`          | `20`    | Token-bucket cap on LML lookups per minute. Shared with `flowsheet-metadata-backfill` so concurrent drains pace cooperatively against LML's Discogs ceiling. |
| `BACKFILL_LML_MAX_CONCURRENT`        | `1`     | Semaphore permit count. Belt-and-suspenders defense against future orchestrator concurrency.                                                                 |
| `BACKFILL_ARTWORK_REPAIR_TIMEOUT_MS` | `35000` | Per-call abort budget. Sized to clear LML#370's 25.25 s per-item cascade-exhaustion cap plus ~10 s of queue-contention headroom.                             |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`     | `60`    | Cooperative-pause window. Defer before each row when a track was inserted into `flowsheet` within this many seconds. Set `0` to disable (catch-up runs).     |
| `LIVE_ACTIVITY_PAUSE_MS`             | `30000` | Sleep between re-probes when DJ activity is detected.                                                                                                        |
| `LIBRARY_METADATA_URL`               | _(req)_ | LML base URL. The job fails fast if unset.                                                                                                                   |

## Counters

The orchestrator reports six counters at job finish:

- `free_form_scanned`, `free_form_repaired`, `free_form_raced`
- `linked_scanned`, `linked_repaired`, `linked_raced`
- `still_null_after_lml`, `error`

`still_null_after_lml` is intentionally lossy across multiple legitimate causes: (a) Discogs genuinely has no cover anywhere; (b) `spacer.gif`-filtered at the chokepoint (BS#649); (c) post-LML#400 deploy, artist-fallback rejections that now correctly miss. Don't read the counter as a single signal — the drain doesn't need to distinguish for its own purpose, but the bucket is a status-flip candidate set for the LML#400 follow-up backfill.

## Interplay with LML#400

A free-form `enriched_match + null-artwork` row where LML#400's fix would (post-deploy) return no result: this drain re-queries LML, gets `results: []`, classifies as `still_null_after_lml`, and leaves `metadata_status = 'enriched_match'` standing — which is now wrong (should be `enriched_no_match`). Not this drain's job to correct (status read-only is the right invariant), but the `still_null_after_lml` output is a status-flip candidate set the #400 follow-up should consume.

## Race guards

- **Free-form**: WHERE narrows by `id = $1 AND artwork_url IS NULL AND metadata_status = 'enriched_match'`. A concurrent fresh enrichment landing between the orchestrator's SELECT and our UPDATE would have flipped one of those two columns; either flip kicks the row out of the predicate, the UPDATE no-ops, and we count it as `free_form_raced`.
- **Linked**: ON CONFLICT DO UPDATE with `setWhere: album_metadata.updated_at < NOW()`. If a concurrent enrichment landed with `updated_at = NOW() + Δ`, the setWhere evaluates false and the UPSERT no-ops. Counted as `linked_raced`.
- **LML throw**: caught and counted as `error`. Row stays in its eligible state — a subsequent run retries it. Idempotent.

## Related

- Upstream: WXYC/library-metadata-lookup#408 (closed by WXYC/library-metadata-lookup#409, merged 2026-05-29).
- Sibling drains: WXYC/Backend-Service#1041 (album-level pending drain), WXYC/Backend-Service#1011 (free-form pending drain), WXYC/Backend-Service#638 (historical drain — closed). This drain covers the post-`enriched_match` residue that none of those touch.
- Same monopolization avoidance as WXYC/Backend-Service#994 / WXYC/Backend-Service#995 demand — shares the `BACKFILL_LML_*` env vars with `flowsheet-metadata-backfill` so cooperative pacing applies when both run.
- LML bulk-endpoint follow-up: WXYC/library-metadata-lookup#368.
