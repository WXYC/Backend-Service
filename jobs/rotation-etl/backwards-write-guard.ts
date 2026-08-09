/**
 * Refuse-by-default guard for the retained (unscheduled) tubafrenzy import.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88) flipped `rotation` to
 * Backend-canonical and unscheduled this job. The code is retained deliberately
 * ("leave the code for now") so it stays invocable in a Phase 6a maintenance
 * window — but invoking it after the SOURCE flip is a BACKWARDS write.
 *
 * The mechanism differs from the flowsheet sibling's, so don't reason by
 * analogy. There is no rotation mirror: `legacy_rotation_id` is written only by
 * `/internal/rotation-webhook`, never back-stamped onto a dj-site-originated
 * row (`rotation-match.mirror.ts` is the badge probe, not a writer). So this
 * job cannot reach a pure dj-site row. What it does reach is every row that
 * ever came from tubafrenzy — and for those it overwrites `rotation_bin`,
 * `kill_date`, `album_id`, and the denormalized `artist_name` / `album_title` /
 * `record_label` from tubafrenzy's copy. Once the music director manages
 * rotation in dj-site, a Backend-side edit to such a row is silently reverted
 * to whatever tubafrenzy still holds.
 *
 * Two further hazards, both live even for a single deliberate run:
 *
 *   - `discogs_release_id_source` flips to 'tubafrenzy_paste' on any row where
 *     tubafrenzy contributes a non-NULL id, restamping provenance that
 *     `jobs/rotation-release-id-backfill` may have written since (BS#1029).
 *   - The `cronjob_runs` watermark froze when the cron stopped. The first run
 *     after a long gap replays the entire accumulated delta through a per-row
 *     awaited upsert loop. Bound or reset the watermark first.
 *
 * The linkage-repair half of this job — the only part that was never a
 * backwards write — now lives in `jobs/legacy-linkage-resolve/` and runs on its
 * own schedule. If that is what you came here for, you do not need this job.
 */

export const BACKWARDS_WRITE_ENV = 'LEGACY_ETL_ALLOW_BACKWARDS_WRITE';

export const isBackwardsWriteAllowed = (raw: string | undefined = process.env[BACKWARDS_WRITE_ENV]): boolean =>
  raw === '1';

export const backwardsWriteRefusalMessage = (jobName: string): string =>
  [
    `${jobName} is retained as one-shot code and refuses to run by default.`,
    '',
    'Backend-Service is the canonical writer for rotation since Phase 3 of the',
    'tubafrenzy decommission (WXYC/wiki#88). This job imports FROM tubafrenzy and',
    'overwrites rotation_bin, kill_date, album_id and the denormalized display',
    'columns on every row that ever came from tubafrenzy — reverting any',
    'Backend-side edit to those rows — and can restamp discogs_release_id_source.',
    '',
    'Its cronjob_runs watermark also froze when the cron stopped, so the first run',
    'after a long gap replays the whole accumulated delta row by row.',
    '',
    'If you want the linkage repair this job used to perform as a tail pass, run',
    '@wxyc/legacy-linkage-resolve instead — it is scheduled, and it is not a',
    'backwards write.',
    '',
    `If you genuinely intend the import, set ${BACKWARDS_WRITE_ENV}=1 and read`,
    'jobs/rotation-etl/README.md first.',
  ].join('\n');
