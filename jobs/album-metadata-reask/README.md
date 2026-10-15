# album-metadata-reask

One-shot job that re-asks LML for `album_metadata` rows whose stored Discogs release disagrees with the catalog card's current LML pin (`pin_mismatch`), or still serves a pin that the pin review removed (`pin_removed`). It is step 3 of the `album_metadata` remediation; the plan, decisions and slices are on the tracker, [WXYC/Backend-Service#3137](https://github.com/WXYC/Backend-Service/issues/3137).

## Status

In progress. With no flags the job runs the dry run (below): it reads, and it never calls LML or writes. `--catalog-pass <run_id>` runs the catalog cover pass alone (below). `--execute`, `--preview` and `--restore` refuse with the issue that builds each one, before any file is read, and exit 1. Any other unknown flag also refuses; `--dry-run` is accepted and changes nothing.

Landed so far:

- The package scaffold ([#3140](https://github.com/WXYC/Backend-Service/issues/3140)).
- `cohort.ts` ([#3142](https://github.com/WXYC/Backend-Service/issues/3142)): the read-only cohort counts and enumeration; see its docblock. Built as `dist/cohort.cjs` for `tests/integration/album-metadata-reask.spec.js`.
- The knobs and the dry run ([#3144](https://github.com/WXYC/Backend-Service/issues/3144)).
- `write.ts`, `artist-keep-sql.ts` and `run-batch.ts` ([#3145](https://github.com/WXYC/Backend-Service/issues/3145)): the guarded `album_metadata` write and one batch of ask, decide and write. Nothing calls `runBatch` yet; the execute loop is [#3151](https://github.com/WXYC/Backend-Service/issues/3151). `write.ts` and `artist-keep-sql.ts` are tsup entries; the integration spec runs `dist/write.cjs`, which bundles the artist rule.
- `catalog-pass.ts` ([#3146](https://github.com/WXYC/Backend-Service/issues/3146)): the catalog cover pass and the `--catalog-pass <run_id>` mode. A tsup entry; the integration spec runs `dist/catalog-pass.cjs` after real album writes.

## The album write

One statement per album (decision 7 on #3137). It locks the `album_metadata` row only while its `discogs_url` still equals the value the cohort read (the race guard), inserts one `album_metadata_reask_backup` row with before and after images of the 13 release- and artist-group columns and the provenance, and updates the row with `updated_at = NOW()`. The backup row and the update commit together or not at all, and the backup's `written_at` equals the row's new `updated_at`. Zero rows back is `skipped_raced`.

- **Release group** (`discogs_url`, `artwork_url`, `release_year`, `label`, `full_release_date`, `genres`, `styles`, `tracklist`): written as a unit from the answer, nulls included; all NULL on `clear` (decision 3).
- **Artist group** (`discogs_artist_id`, `artist_bio`, `artist_wikipedia_url`, `artist_image_url`, `bio_tokens`): `artist-keep-sql.ts`, decision 8. A null in the answer keeps the stored value only when both `discogs_artist_id`s are set and equal; otherwise the answer is written, nulls included. Kept as stored on `clear`, and still imaged, so a restore never meets a missing key. `artist_cleared` counts a stored bio replaced by none.
- **Never written:** the streaming columns, and `library`. The catalog cover is the catalog cover pass's (below), so the catalog watermark moves once per run, not once per album.

`runBatch` asks LML with `allowReleaseResolutionFallback: true` and `budgetMs: null`, decides each admitted row with `decideReask`, and writes only `rebind`, `rebind_unpinned` and `clear`. A failed bulk call carries the whole batch; a write that throws carries its album.

## The catalog cover pass

`library.artwork_url` is served by catalog search and copied into `library.db`, and every other writer to it is fill-null, so a wrong-release catalog cover never heals on its own (BS#2258). Decision 4 on #3137: the pass rewrites it only where it still equals the cover the album write replaced. A catalog cover that differs came from a librarian or another backfill and is never touched.

The pass reads one run's `album_metadata` backup rows. It skips an album whose `album_metadata` row was touched since the write (`updated_at <> written_at`) or that already has a `library` backup row for the run. For the rest it sets `library.artwork_url` to the backup's `after_image->>'artwork_url'` (NULL for a `clear` or a coverless release) where the catalog cover is non-null, equals `before_image->>'artwork_url'`, and differs from the new cover. One statement writes every `library` backup row (`target_table = 'library'`, the album write's provenance) and updates only the rows it backed up.

- **One statement per run.** The catalog watermark trigger `touch_library_watermark` (migration 0185) is `FOR EACH STATEMENT` and fires even on a zero-row UPDATE, and each bump makes every client re-download the catalog (BS#2052). So the pass first sends a read-only probe of the same rows and sends the write only when the probe finds some. An empty probe sends nothing and leaves the watermark alone.
- Probe and write run in one transaction under `SET LOCAL statement_timeout` from `REASK_CATALOG_STATEMENT_TIMEOUT_MS` (default 30 s). After a pass that wrote, the job runs `ANALYZE wxyc_schema.library`.
- **Side effects, accepted:** one watermark bump per pass that writes, and one row-level `cdc_library` `pg_notify` per rewritten row (migration 0046).
- **Idempotent.** A second pass for the same run finds nothing: each rewritten album has its `library` backup row.
- `--catalog-pass <run_id>` runs the pass alone, for a run that died before its end. It reads no input file and takes no other flag. It logs one `catalog_pass` line with `probed` and `rewritten`; a `run_id` with no album writes (a typo) logs `probed: 0`. The execute loop ([#3151](https://github.com/WXYC/Backend-Service/issues/3151)) will call the same function at the end of each run.

## Build and deploy

- `"job-type": "one-shot"`: no schedule.
- `deploy-base.yml` builds and pushes the image on any push to `main` that changes this directory or `Dockerfile.album-metadata-reask`. Until the run loop lands, that image runs only the dry run.
- Local build: `npm run build --workspace=jobs/album-metadata-reask`. Typecheck: `npm run typecheck --workspace=jobs/album-metadata-reask` (also a CI step, since the root typecheck skips `jobs/**`).

## Provenance

The package layout, `tsup.config.ts`, `tsconfig.json` and the Dockerfile are copied from `jobs/album-metadata-bio-fill` (decision 6 on #3137: copy, extract when a third job needs it). `logger.ts` is the per-job logger copy every job carries; consolidating them is [#615](https://github.com/WXYC/Backend-Service/issues/615).

## Input files

`inputs.ts` ([#3141](https://github.com/WXYC/Backend-Service/issues/3141)) parses the three files the run reads. Each must have exactly this header, in this order; every id is a positive integer, no `library_id` repeats, and any line that does not parse refuses the whole file (an empty required value is an error, never a default). A leading BOM, CRLF and a missing final newline are tolerated; quoted values, surrounding whitespace and non-UTF-8 bytes are not. The parser returns each file's SHA-256 and row count for the run log.

| File             | Header                                                                                                                                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin export       | `library_id,discogs_release_id,source,updated_at`                                                                                                                                                | The `\copy` of `lml_cache.library_release_override`. Must have at least one row.                                                                                                                                                                                                                                                                                                             |
| Removal file     | `library_id,discogs_release_id,source`                                                                                                                                                           | Step 2's removed pins whose card has no pin now. May be empty.                                                                                                                                                                                                                                                                                                                               |
| Grading manifest | `library_id,stored_release_id,pin_release_id,pin_source,stored_title_score,pin_title_score,stored_play_rate,pin_play_rate,excluded_other_plays,excluded_inferred_plays,tier,expected_release_id` | Written by the offline grading tooling. Grades are unsigned decimals, empty when the axis cannot grade. The excluded-play counts are required. `tier` is one of `rebind`, `hold_stored_better`, `hold_ungradeable`, `hold_manual`. `expected_release_id` is set only on tier-1 `pin_removed` rows. For a `pin_removed` row, `pin_release_id` is the removed pin. Must have at least one row. |

`admit(row, manifest)` is the admission rule (decision 2 on #3137). A `pin_mismatch` row is asked if its tier is `rebind`, or `hold_ungradeable` with pin source exactly `alex-l-2026`. A `pin_removed` row is asked unless its tier is `hold_manual`. A card missing from the manifest is held as `hold_unmanifested`. A card whose manifest entry graded other releases than the row now has is held as `hold_manifest_stale`.

## Dry run and knobs

The dry run is the default and makes zero LML calls and zero writes. It parses the three input files (and refuses before any database read if one is malformed), logs each file's SHA-256 and row count (`inputs`), counts the whole cohort, enumerates the drainable rows under the cursor, cap and list, applies `admit`, and logs one `dry_run_plan` line: the cohort counts by reason and pin source, the excluded counts by cause (`no_artist_name`, `discogs_unavailable`, `removed_stores_other`), the catalog covers that mirror the stored cover, the admission (asked, the `alex-l-2026` ungradeable exception, held by tier) and the batch count over the asked rows. Compare the cohort count with the plan's Q2 sizing by hand.

Every knob that is set must parse; a value that does not is an error, never a default. The env parsers are copied from `album-metadata-bio-fill` (decision 6).

| Variable                                                    | Default    | Meaning                                                                                                                                           |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REASK_PIN_FILE`, `REASK_REMOVED_FILE`, `REASK_GRADES_FILE` | required   | Paths to the three input files.                                                                                                                   |
| `REASK_BULK_BATCH_SIZE`                                     | 5          | Items per LML bulk request; at most the client cap (100).                                                                                         |
| `REASK_BULK_RATE_PER_MIN`                                   | 4          | Batches per minute.                                                                                                                               |
| `REASK_READ_TIMEOUT_MS`                                     | 300000     | `SET LOCAL statement_timeout` for the cohort reads.                                                                                               |
| `REASK_CATALOG_STATEMENT_TIMEOUT_MS`                        | 30000      | `SET LOCAL statement_timeout` for the catalog cover pass (probe and write).                                                                       |
| `REASK_MAX_ALBUMS`                                          | 0 (no cap) | Stop after this many albums. Must not be smaller than the `REASK_ALBUM_IDS` list.                                                                 |
| `REASK_ALBUM_AFTER_ID`                                      | 0          | Resume cursor: only `album_id` above this.                                                                                                        |
| `REASK_ALBUM_IDS`                                           | none       | Up to 200 comma-separated album ids. With cursor 0, a retry of just those; with a cursor, carried into that run (each id at or below the cursor). |
| `REASK_SAMPLE_SEED`                                         | none       | Seed for the `--preview` sample.                                                                                                                  |
| `REASK_MAX_CONSECUTIVE_FAILED_BATCHES`                      | 3          | Abort after this many failed batches in a row.                                                                                                    |
| `REASK_MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES`               | 3          | Abort after this many `pin_not_bound` batches in a row; 0 disables.                                                                               |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`                            | 300        | Cooperative-pause lookback. Runs set 0 (DJs are on air around the clock).                                                                         |
