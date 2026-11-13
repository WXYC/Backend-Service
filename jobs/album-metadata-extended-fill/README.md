# album-metadata-extended-fill

One-shot fill for [BS#1442](https://github.com/WXYC/Backend-Service/issues/1442). It fills the eight extended `album_metadata` columns from BS#1336 (`tracklist`, `genres`, `styles`, `label`, `full_release_date`, `discogs_artist_id`, `artist_image_url`, `bio_tokens`) on rows written before the enrichment worker started writing them. **Dry-run is the default; writes require `--execute`.**

## Problem

The enrichment worker has written the eight extended columns since BS#1336, but rows written before that, by the May 2026 backfills and by the worker before the change, have them NULL. Every reader of those columns sees no tracklist, genres or artist image for those albums. Nothing re-opens such a row: `apps/enrichment-worker/precheck.ts` (BS#1747) skips any album whose row already carries a Discogs match.

## What it writes, and what it does not

It reads each value from **the release the row's `discogs_url` already names** (`getRelease`, then `getArtistDetails` for its primary artist). It never searches again, because a search lands on a different release for about 40% of cards. For each album it runs one statement:

```sql
UPDATE album_metadata
   SET tracklist = COALESCE(tracklist, $tracklist::jsonb),
       genres = COALESCE(genres, $genres::text[]),
       ... -- styles, label, full_release_date, discogs_artist_id the same way
       artist_image_url = CASE WHEN <same artist> THEN COALESCE(artist_image_url, $image) ELSE artist_image_url END,
       bio_tokens = CASE WHEN artist_bio IS NOT NULL AND <same artist>
                         THEN COALESCE(bio_tokens, $tokens::jsonb) ELSE bio_tokens END
 WHERE album_id = $id
   AND discogs_url = $stored_discogs_url
```

where `<same artist>` is `discogs_artist_id IS NULL OR discogs_artist_id = $artist_id`.

- **Fill-null only.** A value something else wrote first, such as the enrichment worker or `album-metadata-reask`, is never replaced.
- **The `discogs_url` guard.** A row whose stored release changed after the cohort read matches nothing and counts as `release_changed`.
- **`bio_tokens` only beside a bio,** judged inside the UPDATE. They are the bio's structured form, and tokens with no bio would be a second, unreviewed bio.
- **The artist columns describe the artist `discogs_artist_id` names,** or are left alone.
- **Compilations get no artist columns.** For a Various Artists release (Discogs artist 194), a release credited to one of Discogs' placeholder artists (355 "Unknown Artist", 118760 "No Artist"), or one with more than one primary artist, no artist is fetched, and `discogs_artist_id`, `artist_image_url` and `bio_tokens` stay NULL.
- **Over-length values are dropped, not truncated.** A `label` over 255 characters, a `full_release_date` over 32, or an `artist_image_url` over 512 stays NULL and is counted under `too_long`. The album's other columns are still written.
- **`updated_at` is not touched.** Nothing about the row's match changed, and readers that key on it would take every filled row for freshly enriched.

**The pin gate.** Before any release fetch, each batch of 100 albums makes one call for the hand-verified pins of its catalog cards (`lml_cache.library_release_override`, keyed by `library.legacy_release_id`). An album whose pin names a different release than the stored one is `pin_disagrees` and is never filled, because its tracklist and label would be the wrong record's. Re-resolving it belongs to `album-metadata-reask` (BS#3137). If the pins call fails, the whole batch is `pin_unanswered` and carried, and that failed call counts once toward the unanswered abort, not once per album.

## Outcomes

| outcome                       | what happened                                                           | next run                                                           |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `filled`                      | at least one missing column gained a value                              | settled                                                            |
| `nothing_new`                 | the release answered, but no missing column has a value on Discogs      | settled                                                            |
| `release_changed`             | the stored `discogs_url` changed after the cohort read; nothing written | settled                                                            |
| `release_not_found`           | the release 404'd in this run **and** in the previous one               | settled                                                            |
| `pin_disagrees`               | the pin names another release; nothing fetched or written               | settled                                                            |
| `no_release_id`               | the URL names no release                                                | settled                                                            |
| `release_not_found_suspected` | the release 404'd for the first time                                    | carried; its id is listed in `EXTENDED_FILL_NOT_FOUND_RELEASE_IDS` |
| `release_unanswered`          | LML answered 502 or 504                                                 | carried                                                            |
| `pin_unanswered`              | the batch's pins call failed                                            | carried                                                            |
| `write_failed`                | the UPDATE threw                                                        | carried                                                            |

**A 404 is not proof that a release is gone.** LML answers 404 for a real tombstone, but also when its Discogs retry gives up under rate limiting and when Discogs answers 5xx. So a first 404 is carried, and only a second 404 for the same id in a later run, which is a different moment at Discogs, settles it.

The artist is counted separately (`artist` in the summary): `answered`, `not_asked` (a compilation, or no artist id), `unanswered`, `not_found_suspected` or `not_found`. An artist failure never costs the album its six release columns. They are written, and the album is carried so a later run can fill its artist columns. A failed artist fetch is never memoized, so the next album with that artist asks again. An artist that 404s in two runs is settled the same way, and the album keeps NULL artist columns.

## Reading a run

- **"Done" is `reached_end: true` with nothing carried, not an empty cohort.** Many rows stay in the cohort for good: Discogs has no image or no styles for them, or they are compilations. `reached_end` says the run asked every album its cursor and list covered: it was not stopped or aborted, and the cap did not cut it. A run that used its whole `EXTENDED_FILL_MAX_ALBUMS` reports `false`.
- **Resume with `next_run`.** The run's last line (`finished`, or `summary` when it exits non-zero) carries `execute.next_run`: the four variables to start the next run with. Pass all four exactly as given; the two not-found lists are what lets a second 404 settle. `next_run` works like the bio fill's (BS#2786): the cursor is past every album this run asked, and the albums it left are the list, at most 200. When more are left, the first 200 are carried and the cursor stops just below the first one that did not fit. `resume_after_album_id` is a cursor that is safe on its own but stalls; never resume from `last_album_id`.
- **A list with no cursor is a retry of just those albums.** Its `next_run` is the next retry, or `null` when it left nothing.

A run exits non-zero after logging a `summary` line with its partial totals and `next_run` when:

- `EXTENDED_FILL_MAX_CONSECUTIVE_UNANSWERED` albums in a row went unanswered by LML (release, artist or pins call): LML is probably down;
- `EXTENDED_FILL_MAX_CONSECUTIVE_NOT_FOUND` release fetches in a row returned a first 404. Real tombstones are rare and scattered, so a run of them means Discogs is shedding. A second 404 that settles a carried album does not count, since carried albums run back to back;
- 10 writes in a row failed: the database is unreachable, not one bad row; or
- an error ended the run (`error` in the summary), such as an LML auth rejection (401 or 403), which is fatal at once.

`ANALYZE album_metadata` runs after any run that filled a row, aborts and errors included, per `docs/bulk-update-playbook.md`. If the ANALYZE itself fails, the summary says `analyze_failed: true`, keeps `next_run`, and the run exits non-zero; run the ANALYZE by hand. Each batch of 100 also logs `batch_done` with `next_run`, so a run killed without a summary (an OOM kill, a host crash) can resume from its last `batch_done` line.

SIGTERM or SIGINT stops the run, or a probe, before the next album, with `stopped_early: true` and exit 0. A second signal does not wait for the album in flight: it logs the `summary` line as it stands, with `forced_exit: true`, `stopped_early: true`, `reached_end: false` and `next_run`, and exits 1. The abandoned album is safe to lose, since its write is fill-null and `next_run` already covers it.

## Knobs

| variable                                   | default |                                                                                                                |
| ------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| `EXTENDED_FILL_RATE_PER_MIN`               | 30      | LML calls per minute, release and artist fetches together (the pins call is not counted)                       |
| `EXTENDED_FILL_MAX_ALBUMS`                 | 2400    | albums per run; 0 is no cap                                                                                    |
| `EXTENDED_FILL_ALBUM_AFTER_ID`             | 0       | cursor: every album above this id, plus any listed at or below it                                              |
| `EXTENDED_FILL_ALBUM_IDS`                  | unset   | album list, at most 200: with no cursor, a retry of just these; with one, asked as well as everything above it |
| `EXTENDED_FILL_NOT_FOUND_RELEASE_IDS`      | unset   | Discogs release ids that 404'd once, from `next_run`; at most 200                                              |
| `EXTENDED_FILL_NOT_FOUND_ARTIST_IDS`       | unset   | Discogs artist ids that 404'd once, from `next_run`; at most 200                                               |
| `EXTENDED_FILL_MAX_CONSECUTIVE_UNANSWERED` | 10      | abort after this many albums in a row LML left unanswered; 0 disables                                          |
| `EXTENDED_FILL_MAX_CONSECUTIVE_NOT_FOUND`  | 10      | abort after this many first release 404s in a row; 0 disables                                                  |
| `EXTENDED_FILL_PROBE_ALBUMS`               | 0       | the probe: fetch this many albums and log what a write would add, writing nothing                              |
| `EXTENDED_FILL_READ_TIMEOUT_MS`            | 300000  | statement timeout for the counts and the enumeration                                                           |

A value that does not parse is an error, not a silent fallback to the default. There is no live-DJ pause: DJs are on air around the clock, so a pause would only throttle the run.

## Running it

Each step is a separate decision, and each needs Jake's go. Do not chain them.

1. **Before.** Count the cohort and the rows with `tracklist IS NULL AND discogs_url ~ '/release/'` on production.
2. **Dry run.** No flags. It reads the cohort and makes **no** LML calls, so it spends no Discogs quota. It logs the cohort size and each column's gap.
3. **Probe.** `EXTENDED_FILL_PROBE_ALBUMS=100`. It fetches the first 100 albums from LML and writes nothing, but **it spends Discogs quota**: a release or artist that misses LML's discogs-cache goes to the live Discogs API that LML shares with DJ traffic. It logs per-outcome counts (`pin_disagrees` included), the fill rate per column, the release-cache hit share and cache-miss latency, the 404 count, what the compilation gate dropped, `too_long`, and the share of token-fillable rows that have a Wikipedia URL. It opens with a `probe_spends_quota` warning, so a value left in the environment by mistake shows at once. Raise `EXTENDED_FILL_RATE_PER_MIN` only if the hit share is high.
4. **Canary.** `--execute` with `EXTENDED_FILL_MAX_ALBUMS=25`. Spot-check five albums in the DJ site: the tracklist is present and matches the release the Discogs link opens.
5. **The rest,** as chained bounded runs, each started from the previous `next_run`:

   ```sh
   docker run --rm --stop-timeout 120 --env-file ~/.env \
     -e EXTENDED_FILL_ALBUM_AFTER_ID=<next_run.EXTENDED_FILL_ALBUM_AFTER_ID> \
     -e EXTENDED_FILL_ALBUM_IDS=<next_run.EXTENDED_FILL_ALBUM_IDS> \
     -e EXTENDED_FILL_NOT_FOUND_RELEASE_IDS=<next_run.EXTENDED_FILL_NOT_FOUND_RELEASE_IDS> \
     -e EXTENDED_FILL_NOT_FOUND_ARTIST_IDS=<next_run.EXTENDED_FILL_NOT_FOUND_ARTIST_IDS> \
     <image> --execute
   ```

   The job stops only between albums, and one album can take a pins call, a release call and an artist call (29 seconds each at the caller's timeout class) plus its UPDATE, so `--stop-timeout` must exceed about 95 seconds. At 30 calls a minute a 2,400-album run takes 80 to 160 minutes, depending on how many albums fetch an artist.

   The chain is done when a run reports `reached_end: true` and its `next_run` carries no album ids.

6. **After.** Rerun the counts from step 1 and post them on BS#1442 with the run totals.

The DJ site's `/proxy/metadata/album` cache holds an entry for one hour, so a filled album shows its tracklist within an hour without a restart.

## Layout

| file         |                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cohort.ts`  | the cohort predicate, the stats and the enumeration. Also built as `dist/cohort.cjs` for `tests/integration/album-metadata-extended-fill.spec.js` |
| `map.ts`     | the release and artist responses mapped to the eight columns, with the compilation gate and the length limits, pure                               |
| `fetch.ts`   | the paced LML reads, with the per-run artist memo                                                                                                 |
| `pins.ts`    | the pin gate                                                                                                                                      |
| `probe.ts`   | the probe's per-album check and totals                                                                                                            |
| `fill.ts`    | one album: pin, release, artist, write, outcome. Also built as `dist/fill.cjs` for `tests/integration/album-metadata-extended-fill-write.spec.js` |
| `write.ts`   | the guarded UPDATE and the ANALYZE                                                                                                                |
| `resume.ts`  | `next_run` and the stop streaks, pure                                                                                                             |
| `execute.ts` | the `--execute` loop                                                                                                                              |
| `job.ts`     | knobs, modes, signals, `main`                                                                                                                     |

Structural donor: `jobs/album-metadata-bio-fill`. Its helpers are copied, not imported, as for every job.
