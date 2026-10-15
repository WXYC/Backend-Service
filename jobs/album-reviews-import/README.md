# album-reviews-import

One-shot import for [BS#3132](https://github.com/WXYC/Backend-Service/issues/3132) (epic [BS#2791](https://github.com/WXYC/Backend-Service/issues/2791), decided by the station on 2026-10-14). After the form closes, it copies every `album_review_submissions` row that is linked to a library release into `reviews` on that release, once, so that an old review of a record already in the library is an ordinary review: it shows in the release's reviews, **Cite a release in the library** can cite it, and **Use this review** can use it. Rows with no release stay archive-only. [ADR 0011](../../docs/adr/0011-album-review-submissions-separate-archive.md)'s 2026-10-14 amendment records the decision.

## What it does

For each archive row, in id order, the job reports the row under the first skip rule that applies, or imports it. The rules are set out once, in [ADR 0011](../../docs/adr/0011-album-review-submissions-separate-archive.md)'s 2026-10-14 amendment; the order is the contract, pinned by `tests/unit/jobs/album-reviews-import/skip-reason.test.ts`. The counters the job prints are `no_release`, `blank_review`, `cited_by_intake_item`, `already_imported` and `author_too_long`, in that order.

**`author_too_long` rows need a hand decision**: the dry run lists their ids. Decide each one after the dry run and before the single `--apply`. Either leave it archive-only, or shorten its `reviewer_raw` with SQL (this replaces the archive's only copy of the name as typed) and run the dry run again to see the row move into `imported`. After the apply, such a row stays archive-only: do not run the job again to import it, because a run after the station has edited or deleted imported reviews imports the deleted ones again (see below). After the close, Postgres is the archive's system of record ([BS#2812](https://github.com/WXYC/Backend-Service/issues/2812)) and the ETL is retired, so nothing reverts an `UPDATE` of `album_review_submissions.reviewer_raw`. Never `INSERT` into `reviews` by hand: it would carry no provenance, so the archive row would still be listed beside it, and no revision 1.

The insert re-reads the archive row and requires its `album_id` still to be set, so a release delete that committed before a row's insert counts that row under `no_release`, and the run still commits. A delete still in flight when the row's insert runs aborts the apply with SQLSTATE 23503 and rolls it back, so it wrote nothing and may be run again (see Running it). Each imported release stays `KEY SHARE`-locked until the apply commits, so a release delete tried during the apply waits on that lock and can give up at its `lock_timeout`. **Eligible** counts the rows the first three rules let through, so a dry run after a committed apply reports every eligible row under `already_imported` (or `author_too_long`) and imports none, unless an intake item that caused a `cited_by_intake_item` skip has since been filed as a different release: the dry run then reports that row as importable. Do not run `--apply` again for it; bring it to the station.

Each imported row becomes one `reviews` row and one `review_revisions` row, in the same transaction:

| `reviews` column                                            | value                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `album_id`                                                  | the row's `album_id` (`intake_item_id` null)                                                                                                                   |
| `review`, `artist_blurb`, `recommended_tracks`, `buzzwords` | the row's same-named columns                                                                                                                                   |
| `fcc`                                                       | `fcc_violations`                                                                                                                                               |
| `author`                                                    | `reviewer_raw`, trimmed; null when blank                                                                                                                       |
| `author_user_id`, `recorded_by_user_id`                     | null                                                                                                                                                           |
| `medium`, `status`                                          | `typed`, `submitted`                                                                                                                                           |
| `submitted_at`                                              | the row's `submitted_at`                                                                                                                                       |
| `add_date`                                                  | the America/New_York date of `submitted_at`; the current date when it is null                                                                                  |
| `publish_website`, `publish_apps`, `publish_instagram`      | all three equal `social_consent = true` (a form-era "yes" counts for all three surfaces, ADR 0011's third 2026-10-02 amendment); false for a "no" and for null |
| `credit`                                                    | `none` (form reviews are always uncredited)                                                                                                                    |
| `imported_from_submission_id`                               | the row's `id`                                                                                                                                                 |

Revision 1 carries the same five content fields, `edited_by` = the review's `author`, `edited_by_user_id` null, and `edited_at` = the row's `submitted_at` (the column default, now, when that is null). That is what `writeFirstRevisionIfMissing` would write; the job cannot call it, because jobs never import `apps/backend`.

The job only inserts. It never updates or deletes a `reviews` row or an archive row. The insert is `ON CONFLICT (imported_from_submission_id) DO NOTHING`, so two runs at once still write each row once. A dry run reads in a read-only transaction.

## Before the dry run

1. [BS#2812](https://github.com/WXYC/Backend-Service/issues/2812)'s final ingest has run, the album-reviews ETL is retired, and the nightly link pass has finished: it is the only writer of `album_review_submissions.album_id`, and a row linked after the import is not imported.
2. The **conditional-yes read** of `social_consent_raw` is done and corrected in the sheet (ADR 0011). The job gives a form-era yes all three surfaces and never reads `social_consent_raw`, so a "yes, only blog" left uncorrected would publish to Instagram.
3. Migration 0193 (`reviews.imported_from_submission_id`) is applied.

## Running it

Production is read-only for the implementer; the station runs this by hand, **dry run first**. Like `comp-letter-backfill`, it runs from a workstation through an SSH tunnel with `tsx`, and has no Dockerfile.

```sh
npm run build --workspace=@wxyc/database
export DB_HOST=127.0.0.1 DB_PORT=<tunnel-port> DB_NAME=... DB_USERNAME=...
read -rs DB_PASSWORD && export DB_PASSWORD

# Dry run: prints the counts and the ids of the too-long authors, writes nothing.
npx tsx jobs/album-reviews-import/job.ts

# After reading the counts:
npx tsx jobs/album-reviews-import/job.ts --apply
```

The counts line reads `eligible=N imported=N skipped: no_release=N blank_review=N cited_by_intake_item=N already_imported=N author_too_long=N`. In a dry run `imported` is what `--apply` would write. `--apply` runs once to success. A run that rolled back (for example the 23503 abort above, or any error) wrote nothing and may be run again. A run that committed must not be run again; the check after it is a dry run (no `--apply`), which reports `imported=0` unless an intake item that caused a `cited_by_intake_item` skip has since been filed as a different release, in which case it reports that row as importable (the rule above stands: do not run `--apply` again for it, bring it to the station). `WXYC_SCHEMA_NAME` defaults to `wxyc_schema`. A failure prints the SQLSTATE and the names of the table, column and constraint, never a row's values: the archive holds real names ([`docs/pii.md`](../../docs/pii.md)).

## After the apply

**Do not run the job again once the station has edited or deleted imported reviews.** A deleted imported review takes its `imported_from_submission_id` with it, so a later run imports that form review again. Edits are safe to leave, but the job offers nothing to reconcile them, so treat the apply as the end of the job's life. Corrections to an archive row after the run no longer reach the copy.

A release delete copies the cover review a record took from the release without `imported_from_submission_id`, and a catalog restore nulls it when its archive row was deleted meanwhile (both in `docs/adr/0011-...md`'s amendment).
