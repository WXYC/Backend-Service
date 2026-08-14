/**
 * Entry point for the uncovered-release-list job (BS#1877, ADR 0013's
 * "uncovered-release list handoff", sibling to `jobs/album-critic-reviews-etl`).
 *
 * Weekly: computes the `(active rotation ∪ recently played) × album_critic_reviews`
 * anti-join (current active rotation releases and recently-played linked
 * albums with zero critic reviews), further anti-joined against releases
 * already handed off for search at least once
 * (`uncovered_release_search_markers`, migration 0146 — the "searched,
 * found nothing" marker), writes the result as `uncovered-releases.jsonl`,
 * and commits it to `WXYC/research-data` where the `search` crawl mode
 * (RD#16) reads it. See `orchestrate.ts` for the full pipeline shape and
 * `publish.ts` for the handoff mechanism + the credential it needs.
 *
 * Read-only against Backend-Service's own DB (rotation + flowsheet/album_plays
 * + album_critic_reviews + the markers table) plus one write path: a git
 * commit to a repo Backend-Service doesn't otherwise touch. No new outbound
 * web-egress beyond that GitHub API call, no new authenticated endpoint on
 * Backend-Service — keeps this Project #32 freeze-compatible per the ADR.
 *
 * Run procedure: cron-registered via deploy-base's `cron-schedule` from
 * package.json. Container runs to completion. No cooperative pause: the job
 * reads `flowsheet` but never writes it — no pause needed, mirroring every
 * sibling ETL's rationale (it writes only its own table,
 * `uncovered_release_search_markers`, plus a remote file).
 *
 * Required env: the standard `DB_*` set. Optional: `DRY_RUN`, `OUTPUT_PATH`,
 * `PUBLISH`, `RESEARCH_DATA_WRITE_TOKEN`, `SENTRY_DSN`,
 * `UNCOVERED_PLAY_LOOKBACK_DAYS`, `UNCOVERED_MAX_RELEASES_PER_RUN`. See
 * docs/env-vars.md. Unlike `album-critic-reviews-etl`, no token is REQUIRED
 * to run — the DB read + local file write both work with zero external
 * credentials; only the actual cross-repo push needs one.
 *
 * `--backfill`: drop the steady-state play arm's trailing window and drain
 * every linked album ever played (`plays.fetchAllPlayedAlbums`, sourced from
 * the `album_plays` MV), play-count desc. Rotation-lane guards demote from a
 * hard throw to a log+Sentry escalation in this mode — see orchestrate.ts.
 * `UNCOVERED_MAX_RELEASES_PER_RUN` is the one cap knob in both modes; an
 * operator raises it per backfill invocation (see README.md).
 */
import { closeDatabaseConnection, requirePositiveInt } from '@wxyc/database';
import { runJob, resolveDryRun } from './orchestrate.js';
import { fetchActiveRotationRows, resolveCanonicalRelease } from './rotation.js';
import { fetchRecentPlays, fetchAllPlayedAlbums } from './plays.js';
import { loadCoveredLibraryIds, loadHandedOffLibraryIds } from './antijoin.js';
import { recordHandoffs } from './markers.js';
import { writeSnapshotFile, resolveOutputPath } from './writer.js';
import { publishSnapshot, resolvePublishEnabled, resolveResearchDataWriteToken } from './publish.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'uncovered-release-list';

/** Trailing window (days) for the steady-state play arm. Ignored under `--backfill`. */
export const PLAY_LOOKBACK_DAYS_ENV = 'UNCOVERED_PLAY_LOOKBACK_DAYS';
export const PLAY_LOOKBACK_DAYS_DEFAULT = 30;

/** Post-anti-join cap, both modes — the one cap knob. */
export const MAX_RELEASES_PER_RUN_ENV = 'UNCOVERED_MAX_RELEASES_PER_RUN';
export const MAX_RELEASES_PER_RUN_DEFAULT = 400;

export interface UncoveredJobOptions {
  backfill: boolean;
  playLookbackDays: number;
  maxReleasesPerRun: number;
}

/**
 * Pure option parsing — the one operator-facing seam for this job's mode,
 * unit-testable without a run. Mirrors `concerts-poster-enrichment/job.ts`'s
 * `enrichJobOptions` shape, but deliberately does NOT carry a `dryRun`
 * field: this job resolves DRY_RUN from the environment (`resolveDryRun`,
 * orchestrate.ts), documented as an env var in README.md and
 * docs/env-vars.md — copying the donor's `--dry-run` flag would create a
 * second, divergent dry-run switch.
 */
export const uncoveredJobOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): UncoveredJobOptions => {
  const ctx = { context: JOB_NAME };
  return {
    backfill: args.includes('--backfill'),
    playLookbackDays: requirePositiveInt(
      env[PLAY_LOOKBACK_DAYS_ENV],
      PLAY_LOOKBACK_DAYS_ENV,
      PLAY_LOOKBACK_DAYS_DEFAULT,
      ctx
    ),
    maxReleasesPerRun: requirePositiveInt(
      env[MAX_RELEASES_PER_RUN_ENV],
      MAX_RELEASES_PER_RUN_ENV,
      MAX_RELEASES_PER_RUN_DEFAULT,
      ctx
    ),
  };
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const options = uncoveredJobOptions();
    const dryRun = resolveDryRun();
    const outputPath = resolveOutputPath();
    const publishEnabled = resolvePublishEnabled();
    const writeToken = resolveResearchDataWriteToken();
    log('info', 'init', `${JOB_NAME} initialized`, {
      dry_run: dryRun,
      backfill: options.backfill,
      play_lookback_days: options.playLookbackDays,
      max_releases_per_run: options.maxReleasesPerRun,
      output_path: outputPath,
      publish_enabled: publishEnabled,
      has_write_token: writeToken !== null,
    });

    await runJob({
      fetchActiveRotation: fetchActiveRotationRows,
      resolveCanonical: resolveCanonicalRelease,
      fetchPlayCandidates: options.backfill
        ? () => fetchAllPlayedAlbums()
        : () => fetchRecentPlays(options.playLookbackDays),
      loadCovered: loadCoveredLibraryIds,
      loadHandedOff: loadHandedOffLibraryIds,
      writeSnapshot: writeSnapshotFile,
      recordHandoffs,
      publish: (content) => publishSnapshot(content, { token: writeToken, publishEnabled }),
      outputPath,
      maxReleasesPerRun: options.maxReleasesPerRun,
      dryRun,
      backfill: options.backfill,
    });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run
// against the mocked DB, mirroring jobs/album-critic-reviews-etl.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
