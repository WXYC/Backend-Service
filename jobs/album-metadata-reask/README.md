# album-metadata-reask

One-shot job that re-asks LML for `album_metadata` rows whose stored Discogs release disagrees with the catalog card's current LML pin (`pin_mismatch`), or still serves a pin that the pin review removed (`pin_removed`). It is step 3 of the `album_metadata` remediation; the plan, decisions and slices are on the tracker, [WXYC/Backend-Service#3137](https://github.com/WXYC/Backend-Service/issues/3137).

## Status

Scaffold only ([#3140](https://github.com/WXYC/Backend-Service/issues/3140)). The entrypoint logs a `not_implemented` error line and exits 1. It reads and writes nothing. Do not run it.

## Build and deploy

- `"job-type": "one-shot"`: no schedule.
- `deploy-base.yml` builds and pushes the image on any push to `main` that changes this directory or `Dockerfile.album-metadata-reask`. Until the run loop lands, that image only exits 1.
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
