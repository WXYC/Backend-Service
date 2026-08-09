/**
 * Refuse-by-default guard for the retained (unscheduled) tubafrenzy import.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88) flipped `shows` and
 * `flowsheet` to Backend-canonical and unscheduled this job. The code is
 * retained deliberately ("leave the code for now") so it stays invocable in a
 * Phase 6a maintenance window — but invoking it after the SOURCE flip is a
 * BACKWARDS write, and that is not obvious from the outside:
 *
 *   - The shows UPSERT targets `shows.legacy_show_id`, and the live mirror
 *     back-stamps that column onto dj-site-originated shows
 *     (`apps/backend/middleware/legacy/flowsheet.mirror.ts`). A mirrored
 *     dj-site show therefore EXISTS in tubafrenzy, is fetched by
 *     `fetchLegacyShows`, and has its `start_time` / `end_time` / `show_name` /
 *     `legacy_dj_name` overwritten from tubafrenzy's mirror copy.
 *   - The flowsheet UPSERT targets `legacy_entry_id`, which the mirror
 *     back-stamps the same way, and overwrites `play_order`, `add_time`,
 *     `show_id`, `artist_name`, `album_title`, `track_title`.
 *
 * Under the old regime tubafrenzy was authoritative and that overwrite was the
 * point. Under the new one it round-trips Backend's own data through a mirror
 * and lets the copy win. The guard makes that impossible to trip by accident;
 * it does not make the operation safe, so read the job README before setting
 * the override.
 *
 * The linkage-repair half of this job — the only part that was never a
 * backwards write — now lives in `jobs/legacy-linkage-resolve/` and runs on
 * its own schedule. If that is what you came here for, you do not need this
 * job at all.
 */

export const BACKWARDS_WRITE_ENV = 'LEGACY_ETL_ALLOW_BACKWARDS_WRITE';

export const isBackwardsWriteAllowed = (raw: string | undefined = process.env[BACKWARDS_WRITE_ENV]): boolean =>
  raw === '1';

export const backwardsWriteRefusalMessage = (jobName: string): string =>
  [
    `${jobName} is retained as one-shot code and refuses to run by default.`,
    '',
    'Backend-Service is the canonical writer for shows/flowsheet since Phase 3 of the',
    'tubafrenzy decommission (WXYC/wiki#88). This job imports FROM tubafrenzy, and its',
    'upserts key on legacy_show_id / legacy_entry_id — columns the live mirror',
    'back-stamps onto dj-site-originated rows. Running it now overwrites',
    'Backend-canonical data with tubafrenzy’s mirror copy.',
    '',
    'If you want the linkage repair this job used to perform as a tail pass, run',
    '@wxyc/legacy-linkage-resolve instead — it is scheduled, and it is not a',
    'backwards write.',
    '',
    `If you genuinely intend the import, set ${BACKWARDS_WRITE_ENV}=1 and read`,
    'jobs/flowsheet-etl/README.md first.',
  ].join('\n');
