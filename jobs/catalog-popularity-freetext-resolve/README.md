# @wxyc/catalog-popularity-freetext-resolve

Recurring cron (BS#1491 / catalog-popularity Phase-2 Track 1): resolve every distinct free-text `(artist, album)` pair the DJ typed for an unlinked play (`flowsheet.album_id IS NULL`, ~43% of music plays) to a Discogs release id via LML's bulk lookup, persisting verdicts in `flowsheet_freetext_resolution`. The Phase-2 popularity collapse (Track 2) reads this table to attribute the free-text plays that the linked-only `album_plays` signal can't see (J Dilla _Donuts_ 414 plays, Kendrick _DAMN._ 379, Beach Boys _Pet Sounds_ 325 — all invisible to the FK).

## Why a recurring cron (not a one-shot)

Free text keeps growing: every show adds more unlinked plays. The cron drains the eligible long tail across nightly runs (bounded per run by `FREETEXT_RESOLVE_MAX_PAIRS_PER_RUN`) and re-attempts pairs that a later Discogs addition can now match. Modeled on `jobs/flowsheet-metadata-backfill/` (cron-registered via deploy-base, `package.json` `cron-schedule`, cooperative pause) and `jobs/album-level-backfill/` (bulk lookup + dedup-distinct).

## How it works

1. `SELECT DISTINCT (artist_name, album_title)` from `flowsheet WHERE entry_type='track' AND album_id IS NULL`. Scoped inside `db.transaction` + `SET LOCAL statement_timeout` (the `album_id IS NULL` partition isn't index-covered).
2. Fold the raw pairs into normalized dedup keys in JS: `(normalizeArtistName(artist), normalizeAlbumTitle(album))`. The flowsheet free text holds tens of thousands of edition/pressing variants ("Pet Sounds", "Pet Sounds (Remastered)", "Pet Sounds - 2011 Remaster") that collapse to one logical album. SQL has no album-title normalizer, so the dedup happens in JS; one representative raw pair per key is kept for the LML lookup.
3. Load the skip set: pairs already resolved (release id present, permanent) or no-match inside the TTL window. `attempt_at IS NULL` rows (never-tried + transient-failed) are always eligible.
4. Call LML `POST /api/v1/lookup/bulk` with batches of `FREETEXT_RESOLVE_BULK_BATCH_SIZE` items (default 5). The per-batch fetch timeout scales with batch size (`batchSize × 5 s + 5 s` slack), same derivation as `album-level-backfill`.
5. UPSERT each verdict into `flowsheet_freetext_resolution` keyed on the composite PK `(norm_artist, norm_album)`:
   - **match** with `release_id > 0` → `discogs_release_id` set, `match_confidence` set, `resolved_at = now()`.
   - **no_match** (or the BS#1185 `release_id == 0` streaming-only sentinel) → `discogs_release_id = NULL`, `resolved_at = NULL`. Still UPSERTed (a responded outcome) so `attempt_at` is stamped and the TTL retry window arms.
   - **error** (per-item LML exception) or an HTTP-level throw → NOT written, so the pair stays `attempt_at IS NULL` and retries on the next sweep.
6. Cooperative pause (`awaitQuietWindow`) before each batch yields to live DJ activity.

`discogs_master_id` stays NULL: Track 1's release leg is independent of LML Track 0 (which surfaces `master_id` in the lookup result). The UPSERT omits `discogs_master_id` from both the INSERT and the UPDATE `set` clause, so a later Track-0-aware run PRESERVES any master id it wrote — never clobbers it back to NULL.

## Retry policy

The attempt-at marker + a no-match TTL is the retry policy (per `docs/migrations.md` "Attempt-at markers"). The cron re-attempts:

- `attempt_at IS NULL` rows — never tried, or transient-failed (the error arm deliberately leaves them unwritten).
- no-match rows whose `attempt_at` is older than `FREETEXT_RESOLVE_NO_MATCH_TTL_DAYS` — a later Discogs addition can now match them.

There is **no "retire after N"**. A pair with a release id is permanent (never re-attempted).

## Schedule

Default `45 4 * * *` UTC (00:45 ET) from `package.json` `cron-schedule`, registered via deploy-base. Chosen to sit in the overnight low-traffic window in a free minute that does not collide with the other LML-bounded crons (`artist-search-alias-consumer` 04:15, `rotation-artist-backfill` 04:30, `flowsheet-metadata-backfill` 06:00), so they don't all fan out to LML at once.

## Run procedure (manual, e.g. catch-up)

```bash
# 1. Build & push image via GitHub Actions
gh workflow run deploy-manual.yml --ref main -f target=catalog-popularity-freetext-resolve -f version=latest

# 2. SSH to the BS EC2 host
ssh wxyc-ec2

# 3. Dry-run first to verify env + scope (enumerates + normalizes + filters, no LML calls, no writes)
docker run --rm --env-file .env <image> --dry-run

# 4. Run for real. At defaults (batch=5, rate=1/min ≈ 5 pairs/min, cap 5000/run)
#    one nightly run drains up to 5000 eligible pairs. For a catch-up backfill
#    of the full long tail, bump FREETEXT_RESOLVE_BULK_RATE_PER_MIN and
#    FREETEXT_RESOLVE_MAX_PAIRS_PER_RUN=0 (disable the cap).
docker run --rm --env-file .env <image> 2>&1 | tee /tmp/freetext-resolve.log
```

## Env knobs

| Variable                             | Default            | Meaning                                                                                             |
| ------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| `FREETEXT_RESOLVE_BULK_BATCH_SIZE`   | `5`                | Items per LML bulk request. LML caps at 100. Raising this scales the per-batch fetch timeout.       |
| `FREETEXT_RESOLVE_BULK_RATE_PER_MIN` | `1`                | Batches per minute. At the default batch size, 1/min ≈ 5 pairs/min sustained.                       |
| `FREETEXT_RESOLVE_BULK_BUDGET_MS`    | `25000`            | Per-item budget forwarded to LML as `X-Caller-Budget-Ms`. NOT the batch fetch timeout.              |
| `FREETEXT_RESOLVE_NO_MATCH_TTL_DAYS` | `30`               | A no-match pair is re-attempted once its `attempt_at` is older than this.                           |
| `FREETEXT_RESOLVE_MAX_PAIRS_PER_RUN` | `5000`             | Cap on distinct eligible pairs processed per run. `0` disables the cap (drain everything eligible). |
| `FREETEXT_RESOLVE_READ_TIMEOUT_MS`   | `300000` (5min)    | `SET LOCAL statement_timeout` for the DISTINCT enumerate scan.                                      |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`     | `60`               | Cooperative-pause lookback window; `0` disables.                                                    |
| `LIBRARY_METADATA_URL`               | (required)         | LML base URL.                                                                                       |
| `LML_API_KEY`                        | (required in prod) | LML bearer token.                                                                                   |
| `DATABASE_URL`                       | (required)         | Postgres connection string.                                                                         |

## Acceptance verification

After a run:

```sql
-- (1) Resolution rows grew; a healthy fraction carry a release id.
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE discogs_release_id IS NOT NULL) AS resolved,
  count(*) FILTER (WHERE discogs_release_id IS NULL AND attempt_at IS NOT NULL) AS no_match
FROM wxyc_schema.flowsheet_freetext_resolution;

-- (2) Spot-check a known top free-text record.
SELECT * FROM wxyc_schema.flowsheet_freetext_resolution
WHERE norm_artist = 'j dilla' AND norm_album = 'donuts';
```

## Related

- [BS#1491](https://github.com/WXYC/Backend-Service/issues/1491) — this job's parent issue (blocks Track 2, BS#1492).
- [BS#1486](https://github.com/WXYC/Backend-Service/issues/1486) — Phase-2 catalog-popularity epic.
- `WXYC/wiki/plans/catalog-popularity-phase2.md` — the four-track plan; this is Track 1.
- `jobs/album-level-backfill/` — closest template (bulk lookup + dedup-distinct + cooperative pause).
- `jobs/flowsheet-metadata-backfill/` — the recurring-cron + cooperative-pause shape this job follows.
- `docs/migrations.md` "Attempt-at markers" — the `attempt_at` retry convention.
