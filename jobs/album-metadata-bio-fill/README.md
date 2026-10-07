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

| verdict         | meaning                                                                                                           | stays in the cohort           |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `fill`          | trusted match on this row's card, with a bio                                                                      | no                            |
| `no_bio`        | trusted match on this row's card, no bio                                                                          | yes                           |
| `no_match`      | LML searched and found nothing                                                                                    | yes                           |
| `untrusted`     | LML matched by a fallback search (`search_type` is not `direct`)                                                  | yes                           |
| `card_mismatch` | LML resolved a different catalog card                                                                             | yes                           |
| `indeterminate` | LML did not answer: a shed, an error, an out-of-order result, a thrown call, or a degraded lookup short of a fill | yes — and must be asked again |

A `fill` then ends one of three ways, each with its own counter: `filled`, `skipped_raced` (the row had a bio by write time), or `write_failed` (the UPDATE threw). A failed write does not stop the run. The row is logged and carried into the next run exactly as an unanswered row is.

**A degraded lookup is asked again.** LML treats every bulk item as low priority, and when it sheds a lookup's Discogs work it still answers: the library rows alone, flagged `degraded` with a `degraded_reason` of `cache_only` (its admission shed), `deadline_exceeded` (a per-item time limit ran out) or `upstream_unavailable` (a saturated Discogs). Bulk labels that item `match`, or `no_match` when no row came back. Short of a fill it is `indeterminate`, so it is carried into the next run and asked again; the `lml_indeterminate` log line names the reason. A degraded lookup that does carry a bio for the row's card still fills.

`no_bio` is not a stable verdict. When the circuit breaker on LML's artist-details step is open, LML still returns the match, with a null bio and without the `degraded` flag, and that is identical on the wire to an artist with no Discogs profile. For one album the job cannot tell the two apart. For a streak it can: `BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES` (default 10; `0` disables) aborts the run once that many batches in a row filled nothing and came back with at least one `no_bio`. A shed blanks the bio and nothing else, so a shed batch still holds its `no_match`, `untrusted` and `card_mismatch` albums; what it cannot hold is a fill. So only a fill resets the count, and a batch with neither a fill nor a `no_bio` (LML answered for none of it, or only with other verdicts) leaves it as it is. A no-bio streak still running when the run ends is carried in `next_run` whatever ends it: this guard, the failed-batch guard, the pause ceiling or a stop. So a run that stops for another reason in the middle of a shed does not walk past the albums it hit. With the guard set to `0` a streak is not carried, since the operator has judged those bios absent.

**The threshold is sized for batches of 5 and a fill rate near 60%.** At that rate a fill-less batch of 5 is about 1 in 100, so ten in a row will not happen by chance. It is not measured yet: read the canary's `filled / enumerated`. At smaller batches, or a much lower fill rate, fill-less batches become common and the guard will abort healthy runs; raise the knob in step.

- **What the guard catches:** a sustained shed. Without it every album lands `no_bio`, no batch fails, the cursor walks to the end, and the run reports success having skipped real fills.
- **What it cannot catch:** a shed shorter than the streak (under 10 batches, which is 50 albums at the defaults), or a partial one that still lets a fill through every few batches, since a fill resets the count. Those rows are recorded `no_bio` and nothing carries them. The remedy is a final pass over the residue: when the chain is done, run it once more from cursor 0. Only rows that still have no bio are in the cohort, so that pass re-asks exactly them.
- **When it fires on a real cluster:** the cursor walks `album_id` order, so compilations, or the albums of one artist with no profile, can sit together. Raise the knob or set it to `0`, and resume.

## Reading a run

Because only `fill` leaves the cohort, this job differs from `streaming-columns-drain` in three ways an operator needs to know.

- **"Done" is `reached_end: true` with nothing carried.** The cohort does not approach zero. `cohortBefore - cohortAfter` is the number of fills and nothing else. Expect roughly 5,000 rows to remain. `reached_end` says the run asked every album its cursor and list covered: it was not stopped or aborted, and the cap did not cut it. A capped run that used its whole cap reports `false`, since more may lie above it.
- **Resume with `next_run`, not by re-running.** A re-run with no cursor re-asks the whole residue. The run's last line (`finished`, or `summary` when it exits non-zero) carries `next_run`: the `BIO_FILL_ALBUM_AFTER_ID` and `BIO_FILL_ALBUM_IDS` to start the next run with. Pass both, exactly as given. See "Resuming" below.
- **The cursor moves; what it passed and could not settle is carried.** `next_run`'s cursor is past every album this run asked. The albums it left are its list: unanswered (`indeterminate`), `write_failed`, the albums of a no-bio streak that aborted it, and listed albums it never reached. `indeterminate_album_ids` shows the same albums; `indeterminate` and `write_failed` are always the exact counts.

A run exits non-zero, after logging a `summary` line with its partial totals and `next_run`, when:

- the cumulative live-DJ pause exceeds `LIVE_ACTIVITY_MAX_PAUSE_MS` (resume later with `next_run`), or
- `BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES` batches in a row failed, counted separately for LML and the database. LML failed a batch when it answered for at most a fifth of it (4 of 5 at the default size). The database failed one when every write it attempted threw; a batch that attempted no write neither counts nor resets that count. The abort message, and its Sentry event's `cause`, name the streak that tripped: the `lml_batch_failed` and `lml_indeterminate` lines show an LML failure, the `write_failed` lines a database one. Fix that first. Or
- `BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES` batches in a row filled nothing and came back with `no_bio`: LML's artist-details breaker is probably open (see Verdicts). Every album in the streak looked settled, so `next_run` carries them all, to be asked again once LML is healthy. Every `batch_done` line carries the `next_run` as of that batch, streak included, so a run killed before its `summary` line still leaves one; take the last line's.

The `summary` line is logged even when the closing `ANALYZE` or re-count fails, as they will if the database is what went away. It then carries `accounting_failed: true`, and `cohortAfter` is the before-count, not a measurement.

SIGTERM or SIGINT stops it cleanly between batches with `stopped_early: true` and exit 0, provided the container is given long enough to finish the batch in flight. See `--stop-timeout` under "Running it". A second signal does not wait for that batch: it logs the `summary` line as it stands, with `forced_exit: true` and `next_run`, flushes Sentry for up to 2 seconds, and exits 1. The abandoned batch is safe to lose, since its writes are fill-null and `next_run` predates it. A second signal during the closing count logs the finished loop's summary, says the count was cut short and, if the run had aborted, why; one before the run has enumerated its albums, or after it has logged its outcome, logs no summary. The batch in flight can still finish during the flush and log a later `batch_done`; take the last `next_run` in the log. A third signal does nothing more.

### Resuming

Start every run with the previous run's `next_run`. Nothing is skipped: everything above its cursor is asked because it is above the cursor, and everything below it that the previous run left is asked because it is listed. The listed albums are asked first.

- **When more than 200 albums are left**, as after a long LML outage, `next_run` carries the first 200 and its cursor stops just below the first album that did not fit. Every unsettled album at or below the cursor is listed, and the rest are above it, so nothing is skipped; the next run re-asks the settled rows between that album and the previous cursor, and the chain moves on.
- **`resume_after_album_id` on its own is always safe and never skips**, but it stalls: an album that is never answered holds it in place, and each run above it re-asks rows that were already settled. Do not resume from it on its own: always pass `next_run`, which carries the first 200 unsettled albums even when more are left. Never resume from `last_album_id`.
- **A list with no cursor is a retry of just those albums**, under the cohort predicate and the eligibility conditions. An id that got a bio in the meantime, or is not eligible, is not asked: it is named on a `listed_ids_not_in_cohort` line. A retry's `next_run` is the next retry, or `null` when it left nothing.

```sh
docker run --rm --stop-timeout 90 --env-file ~/.env \
  -e BIO_FILL_ALBUM_IDS=53812,53977,54020 \
  <image> --execute
```

A list holds at most 200 ids. Carried into a cursor run, every listed id must be at or below the cursor; and a non-zero `BIO_FILL_MAX_ALBUMS` must not be smaller than the list, or it would drop listed ids unreported.

## Knobs

| variable                                               | default |                                                                                                                |
| ------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| `BIO_FILL_BULK_BATCH_SIZE`                             | 5       | albums per LML bulk request                                                                                    |
| `BIO_FILL_BULK_RATE_PER_MIN`                           | 1       | batches per minute                                                                                             |
| `BIO_FILL_BULK_BUDGET_MS`                              | 0       | per-item budget sent to LML as `X-Caller-Budget-Ms`; 0 sends no header (see below)                             |
| `BIO_FILL_READ_TIMEOUT_MS`                             | 300000  | statement timeout for the counts and the enumeration                                                           |
| `BIO_FILL_MAX_ALBUMS`                                  | 0       | stop after this many albums; 0 is no cap                                                                       |
| `BIO_FILL_ALBUM_AFTER_ID`                              | 0       | cursor: every album above this id, plus any listed at or below it                                              |
| `BIO_FILL_ALBUM_IDS`                                   | unset   | album list, at most 200: with no cursor, a retry of just these; with one, asked as well as everything above it |
| `BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES`              | 3       | abort after this many batches in a row that LML or the database failed                                         |
| `BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES`              | 10      | abort after this many batches in a row that filled nothing and returned a `no_bio`; 0 disables                 |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`                       | 300     | a flowsheet track newer than this means a DJ is live; 0 disables the pause                                     |
| `LIVE_ACTIVITY_PAUSE_MS`, `LIVE_ACTIVITY_MAX_PAUSE_MS` | shared  | see `docs/env-vars.md`                                                                                         |

A value that does not parse is an error, not a silent fallback to the default.

## Running it

Each step below is a separate decision. Do not chain them.

Precondition: `LML_ARTIST_IDENTITY_SPLIT_GATE` is not set false on the LML service. It defaults on; with it off, bulk bios revert to LML's album gate.

1. **Build the image.** `deploy-manual.yml` with this job as the target. A one-shot job is built and pushed, never scheduled.
2. **Dry run.** No flags. It makes zero LML calls. Check `cohortBefore` against the figure above and note `batches`.
3. **Canary.** `--execute` with `BIO_FILL_MAX_ALBUMS=25`. Read the verdict totals: `untrusted` and `card_mismatch` are expected to be zero or close to it, and `filled / enumerated` is the fill rate the no-bio guard is sized against (see Verdicts). Then read the 25 rows back and confirm that bios are present and every other column is unchanged.
4. **The full cohort**, as a chain of bounded runs. At the defaults the cohort is about 2,600 batches at one a minute, which is more than 43 hours and not a window. Instead, start each run with the previous run's `next_run` (the first run sets neither):

   ```sh
   docker run --rm --stop-timeout 90 --env-file ~/.env \
     -e BIO_FILL_BULK_RATE_PER_MIN=4 \
     -e BIO_FILL_MAX_ALBUMS=2400 \
     -e BIO_FILL_ALBUM_AFTER_ID=<previous next_run.BIO_FILL_ALBUM_AFTER_ID> \
     -e BIO_FILL_ALBUM_IDS=<previous next_run.BIO_FILL_ALBUM_IDS> \
     <image> --execute
   ```

   `--stop-timeout` is not optional. `docker stop` sends SIGTERM and kills the container 10 seconds later by default, while the job stops only between batches and a batch in flight can take up to its bulk timeout: 5 seconds per album plus 5, plus LML's 25-second hard cap when no budget header is sent (the default), so 55 seconds at the default batch size of 5. **The stop timeout must exceed the bulk timeout for the batch size in use**, or the kill lands mid-batch and the run ends with no `summary` line and no resume point. The writes count too: each album's UPDATE can wait up to the database statement timeout, `DB_STATEMENT_TIMEOUT_MS`, which defaults to 5 seconds and which this job does not raise. At the defaults that is 55 + 5 × 5 = 80 seconds, so 90 covers it; a batch size of 10 needs more than 130. If the env file raises `DB_STATEMENT_TIMEOUT_MS`, raise `--stop-timeout` by the batch size times the difference.

   **Why no budget header.** LML clamps any `X-Caller-Budget-Ms` to its own `LML_SEARCH_BUDGET_MS`, 4 seconds by default, and once an item has used it LML skips the artist-details step and answers `degraded: deadline_exceeded`. With the header, the canary saw 12% of albums shed this way and the first chained run 25%, and some albums shed on every attempt, which the 200-id carry cannot outlast (BS#2978). Without it an item runs to LML's 25-second hard cap. Set `BIO_FILL_BULK_BUDGET_MS` only to bring the clamp back on purpose.

   The 15-second interval is slept after each batch finishes, so a cycle is the batch plus 15 seconds. LML measured 0.2 to 0.55 seconds per item for this cohort, which would make a batch 1 to 3 seconds of LML time in every 16 to 18 and about 17 to 19 albums a minute. The first production run, with the 4-second clamp, measured about 11: batches took 6 to 12 seconds. Without the clamp the slow albums run longer, so size a 2,400-album run at three to four hours before any live-DJ pause. Keep `LIVE_ACTIVITY_MAX_PAUSE_MS` finite: `0` is uncapped and lets a run sit paused through a whole show.

   The chain is done when a run reports `reached_end: true` and its `next_run` carries no ids. Then run the final residue pass described under Verdicts.

5. **Report** the before and after counts and the verdict totals on BS#2775.

## Layout

| file        |                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cohort.ts` | every statement: the predicate, the counts, the enumeration, the write. Also built as `dist/cohort.cjs` so `tests/integration/album-metadata-bio-fill.spec.js` runs the real statements against Postgres |
| `decide.ts` | `decideBioFill`, pure                                                                                                                                                                                    |
| `job.ts`    | knobs, `runBatch`, the loop, `main`                                                                                                                                                                      |

Structural donor: `jobs/streaming-columns-drain`.
