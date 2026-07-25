# @wxyc/catalog-popularity-freetext-resolve

Recurring cron (BS#1491 / catalog-popularity Phase-2 Track 1): resolve every distinct free-text `(artist, album)` pair the DJ typed for an unlinked play (`flowsheet.album_id IS NULL`, ~43% of music plays) to a Discogs release id via LML's bulk lookup, persisting verdicts in `flowsheet_freetext_resolution`. The Phase-2 popularity collapse (Track 2) reads this table to attribute the free-text plays that the linked-only `album_plays` signal can't see (J Dilla _Donuts_ 414 plays, Kendrick _DAMN._ 379, Beach Boys _Pet Sounds_ 325 — all invisible to the FK).

## Why a recurring cron (not a one-shot)

Free text keeps growing: every show adds more unlinked plays. The cron drains the eligible long tail across nightly runs (bounded per run by `FREETEXT_RESOLVE_MAX_PAIRS_PER_RUN`) and re-attempts pairs that a later Discogs addition can now match. Modeled on `jobs/flowsheet-metadata-backfill/` (cron-registered via deploy-base, `package.json` `cron-schedule`, cooperative pause) and `jobs/album-level-backfill/` (bulk lookup + dedup-distinct).

## How it works

1. `SELECT DISTINCT ON (artist_name, album_title) artist_name, album_title, track_title` from `flowsheet WHERE entry_type='track' AND album_id IS NULL`, over an inner `GROUP BY (artist_name, album_title, track_title)` play-count so the ordering can pick the pair's **most-played non-empty** `track_title` as its representative (BS#1767 — carries a representative track into the LML lookup instead of album-title-only). The most-played track is the album's canonical track; an alphabetically-first 'A…' bonus/intro title is an arbitrary, low-signal representative that resolves worse. Ordering: non-empty first (`btrim(coalesce(track_title,''))='' ASC`), then `play_count DESC`, then `track_title ASC` (deterministic tiebreak). Scoped inside `db.transaction` + `SET LOCAL statement_timeout` (the `album_id IS NULL` partition isn't index-covered; the GROUP BY subquery measured ~17s on prod, within the raised timeout). `DISTINCT ON` over the grouped subquery keeps the result to one row per `(artist, album)` pair (cardinality unchanged — the GROUP BY only picks a better representative track); there is no `track_title IS NOT NULL` filter, so a pair whose plays are all track-less still enumerates and falls back to album-only.
2. Fold the raw pairs into normalized dedup keys in JS: `(normalizeArtistName(artist), normalizeAlbumTitle(album))`. The flowsheet free text holds tens of thousands of edition/pressing variants ("Pet Sounds", "Pet Sounds (Remastered)", "Pet Sounds - 2011 Remaster") that collapse to one logical album. SQL has no album-title normalizer, so the dedup happens in JS; one representative raw pair per key (artist, album, AND its representative track) is kept for the LML lookup. The dedup key itself stays `(norm_artist, norm_album)` — the track only improves _which release_ LML resolves to, never what gets attributed.
3. Load the skip set: pairs already resolved (release id present, permanent) or no-match inside the TTL window. `attempt_at IS NULL` rows (never-tried + transient-failed) are always eligible.
4. Call LML `POST /api/v1/lookup/bulk` with batches of `FREETEXT_RESOLVE_BULK_BATCH_SIZE` items (default 5), including `song` on each item ONLY when the representative track is non-empty (a track-less pair sends artist+album exactly as before). The per-batch fetch timeout scales with batch size (`batchSize × 5 s + 5 s` slack), same derivation as `album-level-backfill`.
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

### The run is bounded to the overnight window (BS#1814)

Each batch is 5 free-text pairs drawn from _unlinked_ plays — the least-cached lookups in the system — so nearly every item triggers a full Discogs cascade and holds LML's `Semaphore(5)` for ~25–30 s. At the default rate (1 batch/min) an unbounded run of a large backlog takes 16+ hours of wall clock, so a run that started at 04:45 UTC would overrun deep into the daytime peak and starve LML into a congestion collapse (the 2026-07-25 incident). Two bounds keep the run inside the overnight window:

- **Absolute stop-by wall-clock — `FREETEXT_RESOLVE_STOP_BY_UTC` (default `11:00` UTC, ≈4 AM PT).** Checked before each batch: once the wall clock reaches today's stop-by, the run finishes the in-flight batch and exits (`stop_reason=stop_by_reached`); it never _starts_ a batch past the deadline. The default gives the 04:45 UTC cron a ~6h15m window and stops well before the daytime peak. Because the bound is an **absolute** time-of-day computed against today's date (never rolled forward to tomorrow), it also no-ops a manually-launched or misfired **daytime** run for free — such a run is already past today's stop hour and exits with zero batches. The remaining pairs drain on the next run: UPSERTs are idempotent and the attempt-marker / no-match-TTL retry policy (below) resumes partial progress, so a mid-run stop — even a `SIGKILL` — loses nothing. The stop-by also bounds the cooperative pause: if a DJ is active near the stop hour, the pause loop yields at the deadline instead of spinning `sleep→re-probe` past it. Set the var empty to disable the bound (for a supervised manual full-drain only).
- **Strengthened cooperative pause — `LIVE_ACTIVITY_LOOKBACK_SECONDS` (default `420`, was `60`).** WXYC broadcasts 24/7, so a live DJ can be adding tracks _during_ the overnight window. The old 60 s lookback slipped through the 3–5 min gap between songs and the job proceeded right into the streaming-check-on-add window. 420 s (7 min) is well above the song-gap range, so an active show reliably parks the job between tracks; it only resumes after ~7 min of true silence. The stop-by bounds the total, so this parking can never carry the run into the daytime.

Together: the **stop-by** bounds the daytime blast radius (the incident), and the **strengthened pause** bounds the overnight residual (yielding to a live overnight show).

## Run procedure (manual, e.g. catch-up)

```bash
# 1. Build & push image via GitHub Actions
gh workflow run deploy-manual.yml --ref main -f target=catalog-popularity-freetext-resolve -f version=latest

# 2. SSH to the BS EC2 host
ssh wxyc-ec2

# 3. Dry-run first to verify env + scope (enumerates + normalizes + filters, no LML calls, no writes)
docker run --rm --env-file .env <image> --dry-run

# 4. Run for real. At defaults (batch=5, rate=1/min ≈ 5 pairs/min, cap 5000/run)
#    a nightly run drains what fits in the overnight window before the
#    FREETEXT_RESOLVE_STOP_BY_UTC=11:00 stop-by (~1875 pairs at the default
#    rate), then exits; the rest drains on later runs. For a SUPERVISED catch-up
#    backfill of the full long tail, bump FREETEXT_RESOLVE_BULK_RATE_PER_MIN,
#    set FREETEXT_RESOLVE_MAX_PAIRS_PER_RUN=0 (disable the pair cap), AND set
#    FREETEXT_RESOLVE_STOP_BY_UTC= (empty, disable the window bound) — only while
#    you are watching LML load, since that removes the overrun guard.
docker run --rm --env-file .env <image> 2>&1 | tee /tmp/freetext-resolve.log
```

## Env knobs

| Variable                             | Default            | Meaning                                                                                                                                                                                                     |
| ------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FREETEXT_RESOLVE_BULK_BATCH_SIZE`   | `5`                | Items per LML bulk request. LML caps at 100. Raising this scales the per-batch fetch timeout.                                                                                                               |
| `FREETEXT_RESOLVE_BULK_RATE_PER_MIN` | `1`                | Batches per minute. At the default batch size, 1/min ≈ 5 pairs/min sustained.                                                                                                                               |
| `FREETEXT_RESOLVE_BULK_BUDGET_MS`    | `25000`            | Per-item budget forwarded to LML as `X-Caller-Budget-Ms`. NOT the batch fetch timeout.                                                                                                                      |
| `FREETEXT_RESOLVE_NO_MATCH_TTL_DAYS` | `30`               | A no-match pair is re-attempted once its `attempt_at` is older than this.                                                                                                                                   |
| `FREETEXT_RESOLVE_MAX_PAIRS_PER_RUN` | `5000`             | Cap on distinct eligible pairs processed per run. `0` disables the cap (drain everything eligible).                                                                                                         |
| `FREETEXT_RESOLVE_STOP_BY_UTC`       | `11:00`            | Absolute stop-by wall-clock (UTC `HH` or `HH:MM`). Finishes the in-flight batch then exits once reached; never starts a batch past it. Empty disables the bound (supervised full-drain only). See Schedule. |
| `FREETEXT_RESOLVE_READ_TIMEOUT_MS`   | `300000` (5min)    | `SET LOCAL statement_timeout` for the DISTINCT enumerate scan.                                                                                                                                              |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`     | `420`              | Cooperative-pause lookback window (7 min, well above the 3–5 min song gap so an overnight live show parks the job). `0` disables. See Schedule.                                                             |
| `LIBRARY_METADATA_URL`               | (required)         | LML base URL.                                                                                                                                                                                               |
| `LML_API_KEY`                        | (required in prod) | LML bearer token.                                                                                                                                                                                           |
| `DATABASE_URL`                       | (required)         | Postgres connection string.                                                                                                                                                                                 |

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

## Post-deploy re-drain (BS#1767)

BS#1767 made the resolver carry a representative track title into the LML bulk lookup, lifting the probed match rate from ~6.0% (album-only) to ~22.0% (album + track) — but `loadSkipKeys` skips no-match rows inside the 30-day TTL, so without a one-time re-arm the ~115k existing no-match pairs won't re-attempt for up to a month. This is an **ops step, run manually after the fix deploys** — not part of the job itself.

Re-arm **only** the no-match cohort. A release id is a permanent verdict — never touch a row that already has one. Run the count first to confirm scope (data-safety convention: verify before writing):

```sql
-- 1. Verify scope first.
SELECT count(*) FROM wxyc_schema.flowsheet_freetext_resolution WHERE discogs_release_id IS NULL;

-- 2. Re-arm: only no-match rows, never a matched row.
UPDATE wxyc_schema.flowsheet_freetext_resolution
SET attempt_at = NULL          -- makes loadSkipKeys treat them as never-tried → eligible next run
WHERE discogs_release_id IS NULL;
```

After the re-arm, the next scheduled run (or a manual catch-up per "Run procedure" above) re-attempts the full no-match cohort with the track-aware lookup. Matched rows (`discogs_release_id IS NOT NULL`) are untouched by this UPDATE.

## Related

- [BS#1767](https://github.com/WXYC/Backend-Service/issues/1767) — carries a representative track title into the bulk lookup (this README's "Post-deploy re-drain" section); +16pts / ~3.7x match-rate lift, 0 regressions in the A/B probe.
- [BS#1491](https://github.com/WXYC/Backend-Service/issues/1491) — this job's parent issue (blocks Track 2, BS#1492).
- [BS#1486](https://github.com/WXYC/Backend-Service/issues/1486) — Phase-2 catalog-popularity epic.
- `WXYC/wiki/plans/catalog-popularity-phase2.md` — the four-track plan; this is Track 1.
- `jobs/album-level-backfill/` — closest template (bulk lookup + dedup-distinct + cooperative pause).
- `jobs/flowsheet-metadata-backfill/` — the recurring-cron + cooperative-pause shape this job follows.
- `docs/migrations.md` "Attempt-at markers" — the `attempt_at` retry convention.
