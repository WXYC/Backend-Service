/**
 * album-metadata-bio-fill — one-shot fill for `album_metadata` rows that carry
 * a Discogs match and no `artist_bio` (BS#2775).
 *
 * This file is the package scaffold only (BS#2776). The cohort and dry run
 * land in BS#2777, the verdict and write in BS#2778, and the execute loop in
 * BS#2779. Until then the entrypoint refuses to run: `deploy-base.yml`
 * discovers Docker targets from the workspace graph, so an image for this job
 * exists from the moment the package merges, and a `docker run` of it must be
 * loud and non-zero rather than an exit 0 that reads as a finished drain.
 *
 * @see WXYC/Backend-Service#2775
 */

import { closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'album-metadata-bio-fill';

export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    log('error', 'not_implemented', `${JOB_NAME} is a scaffold; nothing was read or written`, {});
    process.exitCode = 1;
  } finally {
    await closeLogger();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run (same
// rationale as `streaming-columns-drain#main`).
if (process.env.NODE_ENV !== 'test') {
  void main();
}
