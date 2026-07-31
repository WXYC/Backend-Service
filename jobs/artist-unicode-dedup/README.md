# artist-unicode-dedup

One-shot job that merges pre-existing **Unicode-form-duplicate `artists` rows** (BS#1897).

## Why

The catalog write-boundary matcher (`artistIdFromName`, `apps/backend/services/library.service.ts`) historically matched on `lower(artist_name)` — collation-aware but **not** Unicode-form aware. `Nilüfer Yanya` in NFC (`ü` = U+00FC), NFD (`u` + U+0308), and the ASCII-fold `Nilufer Yanya` are byte-distinct, missed each other, and each spawned a separate `artists` row. Those duplicates silently partition `library` rows across `artist_id`s and break reconciled-identity attachment (which binds to only one row).

Migration `0134` fixes the matcher going forward (the `fold_artist_name` SQL function + `artistIdFromName` now fold NFC/NFD/ASCII-fold/case together). **This job cleans up the rows that already exist.** Run it after 0134 is deployed.

## What it does

- **Groups** `artists` by `wxyc_schema.fold_artist_name(artist_name)` — the exact fold the matcher now uses — keeping only groups of size > 1.
- **Survivor** = the lowest `id` in each group (oldest / most-likely staff-curated).
- **Repoints every FK** that references `artists.id` from each duplicate to the survivor, dropping rows that would collide with an existing survivor row on a unique/PK key:
  - `library.artist_id`, `genre_artist_crossreference.artist_id`, `artist_library_crossreference.artist_id`, `artist_crossreference.source_artist_id` / `target_artist_id`, `artist_search_alias.artist_id` / `related_artist_id`, `artist_similar_artists.artist_id`, `artist_station_plays.artist_id`, `concerts.headlining_artist_id`, `concert_performers.artist_id`.
- **Preserves identity**: COALESCE-fills the survivor's 6 reconciled-identity columns (`discogs_artist_id`, `musicbrainz_artist_id`, `wikidata_qid`, `spotify_artist_id`, `apple_music_artist_id`, `bandcamp_id`) from the duplicates before deletion — the survivor's own non-null value always wins — so a merge never discards an externally-resolved id a duplicate carried.
- **Deletes** the duplicate `artists` rows (only after every FK is repointed — the hard data-safety invariant).
- **NFC-normalizes** the survivor's `artist_name` / `alphabetical_name` / `code_letters` so the surviving row is itself canonical.
- **ANALYZE**s the rewritten tables after an `--execute` run (docs/bulk-update-playbook.md).

## Data safety

- **Dry-run by default.** With no flag the job SELECTs and logs the affected set (survivor, duplicates, per-FK repoint counts) and writes **nothing**. Pass `--execute` to apply.
- **Idempotent.** A completed run leaves exactly one row per fold-group, so a re-run finds no groups and is a no-op.
- **Atomic per group.** Each group's repoints + delete + normalize run in a single transaction — a mid-run abort leaves each group either fully merged or untouched.
- **Do not run `--execute` against production without review.** Inspect the dry-run log first; a folded group is accent-insensitive, so verify no genuinely-distinct artists (rare accent-only-different names) were grouped together before applying.

## Run procedure

Manual Build & Deploy with `target=artist-unicode-dedup`, then SSH to EC2:

```bash
docker run --rm --env-file .env <image>            2>&1 | tee log-dry
# review log-dry, then:
docker run --rm --env-file .env <image> --execute  2>&1 | tee log-exec
```

## Environment

Standard `DB_*` connection variables (same as the other one-shot jobs). See `docs/env-vars.md`.
