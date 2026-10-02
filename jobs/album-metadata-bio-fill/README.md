# album-metadata-bio-fill

One-shot fill for [BS#2775](https://github.com/WXYC/Backend-Service/issues/2775). Writes `artist_bio` and `artist_wikipedia_url` on `album_metadata` rows that carry a Discogs match and have no bio. **Dry-run is the default; writes require `--execute`.**

## Problem

Measured against prod on 2026-10-01, 12,940 of the 33,023 `album_metadata` rows with a Discogs match (39%) had no `artist_bio`, and for about two thirds of those Discogs has a profile. The listener app shows no bio and no Wikipedia link for any play of those albums.

The live enrichment worker did not cause this. Rows it wrote are bio-less at about the rate Discogs itself lacks a profile. The gap is in rows written by the one-shot backfills of May 2026, and by repairs that rewrote a single column and left the rest of the row as it was.

**Nothing else reaches these rows.** `apps/enrichment-worker/precheck.ts` (BS#1747) skips the LML call for any album whose row already carries `artwork_url` or `discogs_url` plus a streaming URL, and a null bio is not one of the fields that re-opens a row. The CDC consumer fires on flowsheet INSERT only. So the writers that produced the gap no longer run, and the one that could repair it is gated off.

## What it writes, and what it does not

For each row in the cohort it asks LML's bulk lookup for the album and, on a trusted match that carries a bio, runs one statement:

```sql
UPDATE album_metadata
   SET artist_bio           = COALESCE(artist_bio, $bio),
       artist_wikipedia_url = COALESCE(artist_wikipedia_url, $wiki),
       updated_at           = NOW()
 WHERE album_id = $id
   AND nullif(discogs_url, '') IS NOT NULL
   AND artist_bio IS NULL
```

The cohort predicate in the `WHERE` is the race guard: a row that got a bio between enumeration and write matches nothing and is counted `skipped_raced`. An existing Wikipedia URL is never replaced.

**Nothing release-scoped is written**, and that is the job's main safety property. LML resolves by search. On a 60-album sample of this cohort it returned the right catalog card 60 times and a _different release_ than the stored one 24 times. So `artwork_url`, `discogs_url`, `release_year` and the streaming columns are left alone, and so are the eight extended columns from BS#1336 (`discogs_artist_id`, `tracklist`, `genres` and the rest), which belong to [BS#1442](https://github.com/WXYC/Backend-Service/issues/1442). A bio is a property of the artist, and LML gates it on artist identity (LML#504) whenever the request sets `extended: true`, which every item here does.

One consequence: dj-site's album panel and the iOS V1 path gate their artist _sub-panel_ on `discogsArtistId`, which this job does not write. The bio appears on the flowsheet feed, which is what the listener app reads. The sub-panel is BS#1442's to fix.

## Verdicts

Each album gets exactly one verdict (`decide.ts`), and only `fill` writes.

| verdict         | meaning                                                                     | stays in the cohort           |
| --------------- | --------------------------------------------------------------------------- | ----------------------------- |
| `fill`          | trusted match on this row's card, with a bio                                | no                            |
| `no_bio`        | trusted match on this row's card, no bio                                    | yes                           |
| `no_match`      | LML searched and found nothing                                              | yes                           |
| `untrusted`     | LML matched by a fallback search (`search_type` is not `direct`)            | yes                           |
| `card_mismatch` | LML resolved a different catalog card                                       | yes                           |
| `indeterminate` | LML did not answer: a shed, an error, an out-of-order result, a thrown call | yes — and must be asked again |

A `fill` then ends one of three ways, each with its own counter: `filled`, `skipped_raced` (the row had a bio by write time), or `write_failed` (the UPDATE threw). A failed write does not stop the run. The row is logged, listed for retry beside the indeterminate ones, and holds the resume cursor exactly as an unanswered row does.

`no_bio` is not a stable verdict. When the circuit breaker on LML's artist-details step is open, LML still returns the match, with a null bio, and that is identical on the wire to an artist with no Discogs profile. For one album the job cannot tell the two apart. For a streak it can: `BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES` (default 10; `0` disables) aborts the run once that many batches in a row came back entirely `no_bio`.

- **What the guard catches:** a sustained shed. Without it every album lands `no_bio`, no batch fails, the cursor walks to the end, and the run reports success having skipped real fills.
- **What it cannot catch:** a shed shorter than the streak (under 10 batches, which is 50 albums at the defaults), or one in which some album in each batch got another verdict, since anything but `no_bio` in a batch resets the count. Those rows are recorded `no_bio` and the cursor passes them. The remedy is a final pass over the residue: when the chain is done, run it once more from cursor 0. Only rows that still have no bio are in the cohort, so that pass re-asks exactly them.
- **When it fires on a real cluster:** the cursor walks `album_id` order, so compilations, or the albums of one artist with no profile, can sit together. Raise the knob or set it to `0`, and resume.

## Reading a run

Because only `fill` leaves the cohort, this job differs from `streaming-columns-drain` in three ways an operator needs to know.

- **"Done" is `stopped_early: false`.** The cohort does not approach zero. `cohortBefore - cohortAfter` is the number of fills and nothing else. Expect roughly 5,000 rows to remain.
- **Resume by cursor, not by re-running.** A re-run with no cursor re-asks the whole residue. Set `BIO_FILL_ALBUM_AFTER_ID` to the previous run's `resume_after_album_id`.
- **`resume_after_album_id` is the safe cursor.** It is the last album at or below which every row was settled, and it stops advancing at the first row that was not: one LML did not answer for (`indeterminate`) or one whose write threw (`write_failed`). Resuming from `last_album_id` instead would skip every such album. `indeterminate_album_ids` lists up to 200 of them, both kinds together; `indeterminate` and `write_failed` are always the exact counts.

A run exits non-zero, after logging a `summary` line with its partial totals and resume point, when:

- the cumulative live-DJ pause exceeds `LIVE_ACTIVITY_MAX_PAUSE_MS` (resume later from the logged cursor), or
- `BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES` batches in a row settled nothing: LML answered for no album in them, or every write they attempted threw. Either LML or the database is down. The `lml_batch_failed` and `lml_indeterminate` lines point at LML and the `write_failed` lines at the database; fix that first. Or
- `BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES` batches in a row came back entirely `no_bio`: LML's artist-details breaker is probably open (see Verdicts). The summary's `resume_after_album_id` is put back to before the first batch of that streak, so a resume re-asks those rows. Take the cursor from the `summary` line, not from the streak's `batch_done` lines, which show it further on.

The `summary` line is logged even when the closing `ANALYZE` or re-count fails, as they will if the database is what went away. It then carries `accounting_failed: true`, and `cohortAfter` is the before-count, not a measurement.

SIGTERM or SIGINT stops it cleanly between batches with `stopped_early: true` and exit 0, provided the container is given long enough to finish the batch in flight. See `--stop-timeout` under "Running it".

## Knobs

| variable                                               | default |                                                                                |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------ |
| `BIO_FILL_BULK_BATCH_SIZE`                             | 5       | albums per LML bulk request                                                    |
| `BIO_FILL_BULK_RATE_PER_MIN`                           | 1       | batches per minute                                                             |
| `BIO_FILL_BULK_BUDGET_MS`                              | 25000   | per-item budget forwarded to LML                                               |
| `BIO_FILL_READ_TIMEOUT_MS`                             | 300000  | statement timeout for the counts and the enumeration                           |
| `BIO_FILL_MAX_ALBUMS`                                  | 0       | stop after this many albums; 0 is no cap                                       |
| `BIO_FILL_ALBUM_AFTER_ID`                              | 0       | resume cursor: only albums above this id                                       |
| `BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES`              | 3       | abort after this many batches in a row that settled nothing                    |
| `BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES`              | 10      | abort after this many batches in a row that were entirely `no_bio`; 0 disables |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`                       | 300     | a flowsheet track newer than this means a DJ is live; 0 disables the pause     |
| `LIVE_ACTIVITY_PAUSE_MS`, `LIVE_ACTIVITY_MAX_PAUSE_MS` | shared  | see `docs/env-vars.md`                                                         |

A value that does not parse is an error, not a silent fallback to the default.

## Running it

Each step below is a separate decision. Do not chain them.

Precondition: `LML_ARTIST_IDENTITY_SPLIT_GATE` is not set false on the LML service. It defaults on; with it off, bulk bios revert to LML's album gate.

1. **Build the image.** `deploy-manual.yml` with this job as the target. A one-shot job is built and pushed, never scheduled.
2. **Dry run.** No flags. It makes zero LML calls. Check `cohortBefore` against the figure above and note `batches`.
3. **Canary.** `--execute` with `BIO_FILL_MAX_ALBUMS=25`. Read the verdict totals: `untrusted` and `card_mismatch` are expected to be zero or close to it. Then read the 25 rows back and confirm that bios are present and every other column is unchanged.
4. **The full cohort**, as a chain of bounded runs. At the defaults the cohort is about 2,600 batches at one a minute, which is more than 43 hours and not a window. Instead:

   ```sh
   docker run --rm --stop-timeout 60 --env-file ~/.env \
     -e BIO_FILL_BULK_RATE_PER_MIN=4 \
     -e BIO_FILL_MAX_ALBUMS=2400 \
     -e BIO_FILL_ALBUM_AFTER_ID=<previous run's resume_after_album_id> \
     <image> --execute
   ```

   `--stop-timeout` is not optional. `docker stop` sends SIGTERM and kills the container 10 seconds later by default, while the job stops only between batches and a batch in flight can take up to its bulk timeout: 5 seconds per album plus 5, so 30 seconds at the default batch size of 5. **The stop timeout must exceed the bulk timeout for the batch size in use**, or the kill lands mid-batch and the run ends with no `summary` line and no resume point. 60 covers the default with room for the writes; a batch size of 10 already needs more than 55.

   The 15-second interval is slept after each batch finishes, so a cycle is the batch plus 15 seconds. LML measured 0.2 to 0.55 seconds per item for this cohort, so a batch is 1 to 3 seconds of LML time in every 16 to 18: about 17 to 19 albums a minute, two to two and a half hours a run before any live-DJ pause, six runs. Keep `LIVE_ACTIVITY_MAX_PAUSE_MS` finite: `0` is uncapped and lets a run sit paused through a whole show.

5. **Report** the before and after counts and the verdict totals on BS#2775.

## Layout

| file        |                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cohort.ts` | every statement: the predicate, the counts, the enumeration, the write. Also built as `dist/cohort.cjs` so `tests/integration/album-metadata-bio-fill.spec.js` runs the real statements against Postgres |
| `decide.ts` | `decideBioFill`, pure                                                                                                                                                                                    |
| `job.ts`    | knobs, `runBatch`, the loop, `main`                                                                                                                                                                      |

Structural donor: `jobs/streaming-columns-drain`.
