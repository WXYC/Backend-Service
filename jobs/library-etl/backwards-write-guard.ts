/**
 * Refuse-by-default guard for the retained (unscheduled) tubafrenzy catalog import.
 *
 * `package.json` declares `job-type: one-shot`, so this job is not scheduled, but
 * it stays invocable. Invoking it is now a BACKWARDS write, the same category as
 * `jobs/flowsheet-etl` and `jobs/rotation-etl`, which carry the same guard.
 *
 * Why the whole job is gated rather than a column list trimmed (WXYC/Backend-Service#2581):
 * tubafrenzy's MySQL catalog has been frozen since `/wxycdb` went dark on 2026-09-16
 * (`cd8f058e`), and dj-site's classic catalog interface now edits essentially all of
 * `LEGACY_SOURCED_LIBRARY_COLUMNS`, not just `code_number` / `code_volume_letters`.
 * Removing two columns from the refresh set would leave the other thirteen reverting.
 * `genre_artist_crossreference.artist_genre_code` (an artist's call number) is also
 * operator-editable now, via `POST /library/artists/{id}/refile` (BS#2643), and
 * `ensureGenreArtistCrossref` upserts it from upstream. So every run reverts
 * Backend-side edits to every release and artist that tubafrenzy ever held.
 *
 * The revert is not just a data problem: call-number relabelling is PHYSICAL, so a
 * revert leaves discs mislabelled the other way (see
 * `jobs/library-call-number-dedup/README.md`, "Sequencing"). The documented
 * full-resync recipe (deleting the `library-etl` rows from `cronjob_runs`) makes
 * it catalog-wide.
 *
 * Inserting NEW releases is unchanged when the variable is set.
 */

export const BACKWARDS_WRITE_ENV = 'LEGACY_ETL_ALLOW_BACKWARDS_WRITE';

export const isBackwardsWriteAllowed = (raw: string | undefined = process.env[BACKWARDS_WRITE_ENV]): boolean =>
  raw === '1';

export const backwardsWriteRefusalMessage = (jobName: string): string =>
  [
    `${jobName} is retained as one-shot code and refuses to run by default.`,
    '',
    "tubafrenzy's catalog has been frozen since /wxycdb went dark on 2026-09-16, and",
    'dj-site now owns catalog edits. This job upserts FROM tubafrenzy on',
    'legacy_release_id and overwrites the library columns it refreshes (code_number,',
    'code_volume_letters, album_title, artist_id, genre_id, ...) and the',
    'genre_artist_crossreference.artist_genre_code call number, reverting every',
    'dj-site edit and artist re-file on rows that came from tubafrenzy.',
    '',
    'The revert is physical as well as logical: discs already relabelled on the shelf',
    'end up mislabelled the other way. A full re-sync (deleting the library-etl rows',
    'from cronjob_runs) makes it catalog-wide.',
    '',
    `If you genuinely intend the import, set ${BACKWARDS_WRITE_ENV}=1 and read`,
    'jobs/library-etl/README.md first.',
  ].join('\n');
