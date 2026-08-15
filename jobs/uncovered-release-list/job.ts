/**
 * Entry point for the uncovered-release-list job (BS#1877, ADR 0013's
 * "uncovered-release list handoff", sibling to `jobs/album-critic-reviews-etl`).
 *
 * Weekly: computes the `rotation × album_critic_reviews` anti-join (current
 * active rotation releases with zero critic reviews), further anti-joined
 * against releases already handed off for search at least once
 * (`uncovered_release_search_markers`, migration 0156 — the "searched,
 * found nothing" marker), writes the result as `uncovered-releases.jsonl`,
 * and commits it to `WXYC/research-data` where the `search` crawl mode
 * (RD#16) reads it. See `orchestrate.ts` for the full pipeline shape and
 * `publish.ts` for the handoff mechanism + the credential it needs.
 *
 * Read-only against Backend-Service's own DB (rotation + album_critic_reviews
 * + the new markers table) plus one write path: a git commit to a repo
 * Backend-Service doesn't otherwise touch. No new outbound web-egress beyond
 * that GitHub API call, no new authenticated endpoint on Backend-Service —
 * keeps this Project #32 freeze-compatible per the ADR.
 *
 * Run procedure: cron-registered via deploy-base's `cron-schedule` from
 * package.json. Container runs to completion. No cooperative pause: the job
 * writes only its own table (`uncovered_release_search_markers`) plus a
 * remote file, never flowsheet-adjacent, mirroring every sibling ETL's
 * rationale.
 *
 * Required env: the standard `DB_*` set. Optional: `DRY_RUN`, `OUTPUT_PATH`,
 * `PUBLISH`, `RESEARCH_DATA_WRITE_TOKEN`, `SENTRY_DSN`. See docs/env-vars.md.
 * Unlike `album-critic-reviews-etl`, no token is REQUIRED to run — the DB
 * read + local file write both work with zero external credentials; only
 * the actual cross-repo push needs one.
 */
import { closeDatabaseConnection } from '@wxyc/database';
import { runJob, resolveDryRun } from './orchestrate.js';
import { fetchActiveRotationRows, resolveCanonicalRelease } from './rotation.js';
import { loadCoveredLibraryIds, loadHandedOffLibraryIds } from './antijoin.js';
import { recordHandoffs } from './markers.js';
import { writeSnapshotFile, resolveOutputPath } from './writer.js';
import { publishSnapshot, resolvePublishEnabled, resolveResearchDataWriteToken } from './publish.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'uncovered-release-list';

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const dryRun = resolveDryRun();
    const outputPath = resolveOutputPath();
    const publishEnabled = resolvePublishEnabled();
    const writeToken = resolveResearchDataWriteToken();
    log('info', 'init', `${JOB_NAME} initialized`, {
      dry_run: dryRun,
      output_path: outputPath,
      publish_enabled: publishEnabled,
      has_write_token: writeToken !== null,
    });

    await runJob({
      fetchActiveRotation: fetchActiveRotationRows,
      resolveCanonical: resolveCanonicalRelease,
      loadCovered: loadCoveredLibraryIds,
      loadHandedOff: loadHandedOffLibraryIds,
      writeSnapshot: writeSnapshotFile,
      recordHandoffs,
      publish: (content) => publishSnapshot(content, { token: writeToken, publishEnabled }),
      outputPath,
      dryRun,
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
