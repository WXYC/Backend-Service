# streaming-columns-drain

One-shot heal for BS#2295. Fills the five streaming URL columns on `album_metadata` rows that carry a load-bearing Discogs match but have **no streaming URLs at all**, so they stop serving a terminal `enriched_match` with five permanent nulls. **Dry-run is the default; writes require `--execute`.**

## Problem

`apps/enrichment-worker/precheck.ts` used to skip the LML call whenever `artwork_url OR discogs_url` was non-null. `finalizeFromCachedMetadata` then flipped the flowsheet row to `enriched_match` and — correctly, since the skip meant there was nothing new to write — performed no `album_metadata` write at all. An album that acquired `artwork_url` from a path that didn't also land streaming URLs was frozen in that shape for the life of the album: every client read a terminal status asserting "this album is enriched" alongside five null streaming URLs, and iOS greyed all five buttons.

The forward fix ([PR #2298](https://github.com/WXYC/Backend-Service/pull/2298)) stops the bleeding — the gate now also requires at least one streaming URL, so a cohort row falls through to LML the next time its album is **played**. This job is the other half: the standing backlog does not heal on its own.

**Nothing else reaches this cohort.** Worth stating explicitly, because four mechanisms look like they should:

| Mechanism                          | Why it misses                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CDC enrichment consumer            | fires on flowsheet INSERT only                                                                                                                          |
| `enrichment-worker/sweep.ts`       | targets stranded `enriching` claims                                                                                                                     |
| `streaming-reask.ts` hourly sweep  | keys on an `'unresolved'` streaming **status**; this cohort's three status columns are all NULL — it was never asked, so there is no verdict to re-open |
| `flowsheet-metadata-backfill` cron | keys on `metadata_attempt_at IS NULL`; these rows were attempted                                                                                        |

So an album in this shape that is never played again stays frozen forever.

## Cohort predicate

Defined once in `cohortPredicateSql()` and reused verbatim by the before-count, the enumeration, the per-row UPDATE's `WHERE`, and the after-count, so the four cannot drift:

```sql
(artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
AND spotify_url IS NULL
AND apple_music_url IS NULL
AND youtube_music_url IS NULL
AND bandcamp_url IS NULL
AND soundcloud_url IS NULL
```

This is the exact complement of the `hasAnyStreamingUrl` conjunct the forward fix added to `precheck.ts`: a row matching here is precisely a row that predicate now refuses to skip.

```sql
-- Confirm scope BEFORE running (org data-safety rule). Same predicate the job uses.
SELECT count(*) FROM wxyc_schema.album_metadata
WHERE (artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
  AND spotify_url IS NULL AND apple_music_url IS NULL AND youtube_music_url IS NULL
  AND bandcamp_url IS NULL AND soundcloud_url IS NULL;
```

The enumeration narrows further, and the gap between the two counts is expected rather than a bug: rows with no usable artist name (both `artists.artist_name` and `library.artist_name` NULL) and rows flagged `library.discogs_unavailable` are excluded, and stay frozen by design. The job logs `excluded` so the gap is visible.

## What it writes, and what it deliberately does not

**Only the five streaming URL columns, and only where they are NULL.** The identity columns (`artwork_url`, `discogs_url`, `release_year`, the bio fields) are never touched.

That is the load-bearing safety property, not timidity. LML resolves by **search**, so a lookup for "Funkadelic / Hardcore Jollies" can legitimately land on a different catalog release — a 102-album run documented in `reference_bs_prod_db_blocked_by_classifier` caught exactly one such mis-resolution, which would have put one album's artwork on another. Writing only streaming URLs keeps the blast radius at a wrong link rather than a wrong album.

Per-column policy, matching `enrich.ts`'s write arms exactly:

- **`youtube_music_url` / `bandcamp_url` / `soundcloud_url`** — always written: LML's verified URL when present, else the synthesized search URL from `@wxyc/metadata#synthesizeSearchUrls`. These are a pure function of our own `library` text, so they cannot be mis-resolved at all, and they are what guarantee every drained row leaves the cohort **including on a `no_match`**.
- **`spotify_url` / `apple_music_url`** — written only when LML returns a real one. There is deliberately no synthesized fallback for these two (BS#1184 / BS#1192): persisting a keyword-search URL would launder "we could not verify a match" into a clickable button. The proxy fills them at read time instead.
- **`spotify_status` / `apple_music_status`** — set to `'unresolved'` on a **match** whose URL came back empty, so BS#1915's bounded hourly `streaming-reask.ts` sweep can adjudicate later. Leaving them NULL would freeze the row a second, subtler way: `schema.ts` is explicit that a NULL status means "never consulted" and is **not** re-ask-eligible. `'unresolved'` is chosen over the more confident `'absent'` because this job cannot distinguish "LML looked and the service has nothing" from "LML never got that far", and `'absent'` is terminal — the attempt cap bounds the cost of being wrong in the safe direction. On a `no_match` the status columns are left alone, exactly as `enrich.ts`'s linked no-match arm does.

### Indeterminate verdicts are never written

A shed (`shed_limiter_saturated` / `shed_breaker_open`), a per-item error, an out-of-order result, or a thrown bulk call writes **nothing**. The row stays in the cohort and the next run retries it.

This is the design point most worth not getting wrong, and the first draft of this job got it backwards — it wrote a synthesized-only fill on every non-match, reasoning that "skipping here means frozen forever." That reasoning is false: **this job is the re-runner**, and the cohort predicate is its resume mechanism. Writing on a shed would take the row out of the cohort permanently, satisfy `precheck.ts`'s new `hasAnyStreamingUrl` conjunct so the next play skips LML again, and leave `streaming-reask.ts` still unable to see it. One LML restart mid-drain would have permanently nulled Spotify and Apple on every remaining album. `@wxyc/lml-client`'s `buildShedBulkResultItem` docstring states the rule: _"never a terminal write, always re-attempted next run. Do NOT assume any bulk caller 'never sheds' — branch on `status`, not on `lookup` nullity."_

### Known limit — read this before judging the result

The V2 flowsheet feed is a plain `coalesce(album_metadata.X, flowsheet.X)` (`apps/backend/utils/album-metadata-projection.ts`) and does **not** synthesize spotify/apple at read time the way `GET /proxy/metadata/album` does. So a drained album for which LML has no verified Spotify or Apple link still serves null for those two on the V2 feed, and iOS still greys those two buttons.

That asymmetry is pre-existing and is **not** something this drain can fix — it is a read-path change, and it deserves its own ticket. Judge a drained row by "did it leave the cohort", not by "are all five buttons lit".

## Safety properties

- **Dry-run by default, and it makes ZERO LML calls.** `--execute` is the only way to write. The dry run stops _before_ the batch loop — it reports the counts and the plan and returns — so an operator sizing the job cannot accidentally spend the whole Discogs quota. (The newer sibling convention from `streaming-url-upgrade` / `streaming-url-remediation`, not `album-level-backfill`'s older `--dry-run` opt-in — a reader carrying that muscle memory still gets a dry run, and there is a unit test pinning exactly that.)
- **Fill-null, twice over.** Each column is `COALESCE(<col>, $new)`, _and_ the full cohort predicate is re-asserted in the UPDATE's `WHERE`. The second is the TOCTOU guard, and it is live rather than theoretical now that the forward fix lets the worker re-open these rows: if any of the five became non-null since enumeration, the UPDATE matches zero rows and the album is counted `skipped_raced`. The row is left **completely** alone rather than partially topped up — two writers' values must never interleave on one album.
- **Idempotent.** A drained row drops out of the cohort, so a second run is a no-op.
- **Never mints a row.** An album with no `album_metadata` row is the enrichment worker's job; creating one here would assert a match nobody made.
- **Degraded rather than skipped on LML failure.** A thrown bulk call does not abandon the chunk — every candidate still gets its synthesized-only fill, because the three search URLs never needed LML. This differs from `album-level-backfill`, which has nothing to write without a match and so leaves the row for the next sweep. Here, leaving the row means leaving it frozen forever.
- **Cooperative pause.** Defers while a DJ is live (`LIVE_ACTIVITY_LOOKBACK_SECONDS`).
- **`ANALYZE` after** any run that wrote, per [`docs/bulk-update-playbook.md`](../../docs/bulk-update-playbook.md) — the pre-check gate now reads these five columns on every enrichment, so the planner needs fresh NULL fractions.

## Env knobs

| Variable                         | Default        | Meaning                                                                                                       |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `DRAIN_BULK_BATCH_SIZE`          | `5`            | Items per LML bulk request. LML caps at 100; 5 is the BS#1197 empirical ceiling under live worker contention. |
| `DRAIN_BULK_RATE_PER_MIN`        | `1`            | Batches per minute. At the default batch size, ~5 albums/min.                                                 |
| `DRAIN_BULK_BUDGET_MS`           | `25000`        | Per-item `X-Caller-Budget-Ms`. Kept — this is a batch drain, not the live lane (BS#1914 / #1978).             |
| `DRAIN_READ_TIMEOUT_MS`          | `300000`       | Statement timeout for the counts and the enumeration.                                                         |
| `DRAIN_MAX_ALBUMS`               | `0` (uncapped) | Stop after N albums. Set it for the bounded canary run.                                                       |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS` | `300`          | Cooperative-pause window. `0` disables.                                                                       |
| `LIVE_ACTIVITY_PAUSE_MS`         | `30000`        | Per-iteration pause. Shared knob (`@wxyc/database`, BS#2147).                                                 |
| `LIVE_ACTIVITY_MAX_PAUSE_MS`     | `1800000`      | Cumulative pause ceiling; the run stops rather than spinning through a whole show. `0` = uncapped.            |

## Run procedure (production)

```bash
# 1. Build & push the image
gh workflow run deploy-manual.yml --ref main \
  -f target=streaming-columns-drain -f version=latest

# 2. SSH to the BS EC2 host (see MEMORY.md / reference_ec2_access.md)
ssh wxyc-ec2

# 3. Confirm no sibling LML job is mid-run — they share LML's Discogs ceiling
docker ps -a --filter name=flowsheet-metadata-backfill-cron --format '{{.Status}}'
# Must show Exited.

# 4. Dry-run. Reports cohort_before, enumerated, excluded, and the batch plan
#    with ZERO LML calls and zero writes.
docker run --rm --env-file .env <ECR-URI>/streaming-columns-drain:<tag>

# 5. Bounded canary FIRST. 25 albums, ~5 minutes at the defaults.
docker run --rm --env-file .env -e DRAIN_MAX_ALBUMS=25 \
  <ECR-URI>/streaming-columns-drain:<tag> --execute

#    Then spot-check one drained album on the live V2 feed before going wider.

# 6. Full run, off-peak.
docker run --rm --env-file .env \
  <ECR-URI>/streaming-columns-drain:<tag> --execute 2>&1 | tee /tmp/streaming-columns-drain.log
```

At the default pacing (batch 5, 1 batch/min) the run takes roughly `cohort / 5` minutes. Size it from the dry-run's `enumerated` before committing to a window; raise `DRAIN_BULK_RATE_PER_MIN` for a catch-up run but keep `DRAIN_BULK_BATCH_SIZE` at 5 so the per-batch fetch-timeout headroom stays intact (BS#1078 Phase 3 evidence).

## Post-run verification

The job reports `cohort_before` / `cohort_after` / `delta` itself — that is BS#2295's "catalog-wide count of the frozen shape reported before and after the drain" acceptance criterion, and it should be quoted onto the issue.

`cohort_after` will not reach zero: the permanently-excluded rows (no usable artist name, or `discogs_unavailable`) stay. On an **uncapped** run that hit no indeterminate verdicts, expect `cohort_after == excluded`. `excluded` is computed against the uncapped eligible count, so it stays meaningful under `DRAIN_MAX_ALBUMS` — a bounded canary reports the real exclusion figure and leaves the rest as remaining work rather than counting it as excluded.

A non-zero `indeterminate` means those rows were deliberately left for the next run; re-run the job to pick them up.

One thing to know if `ENRICHMENT_BANDCAMP_REASK` is ever turned on: the drain writes `bandcamp.com/search` URLs with `bandcamp_status = NULL`, which is exactly the legacy frozen shape that flag's disjunct in `precheck.ts` targets. Flag-off (the default) this is inert, but flipping it after a large drain hands the hourly re-ask sweep a correspondingly large new cohort.

Then check the four rows named in the issue actually serve links:

```sql
SELECT f.id, f.album_id, am.spotify_url, am.youtube_music_url, am.bandcamp_url
FROM wxyc_schema.flowsheet f
JOIN wxyc_schema.album_metadata am ON am.album_id = f.album_id
WHERE f.id IN (5312465, 5312434, 5312385, 5312290);
```

Remember the read-path caveat above before reading a null `spotify_url` as a failure.
