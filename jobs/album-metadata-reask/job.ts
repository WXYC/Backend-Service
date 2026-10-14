/**
 * album-metadata-reask — one-shot re-ask of LML for `album_metadata` rows whose
 * stored Discogs release disagrees with the catalog card's current pin, or
 * still serves a pin that was removed (BS#3137).
 *
 * This file is the package scaffold only (BS#3140). The cohort, verdicts,
 * write and run loop land in the later slices of BS#3137. Until then the
 * entrypoint refuses to run: `deploy-base.yml` builds a one-shot's image on
 * any push that changes `jobs/album-metadata-reask/` or its Dockerfile, so an
 * image exists from the moment the package merges, and a `docker run` of it
 * must be loud and non-zero rather than an exit 0 that reads as a finished
 * re-ask.
 *
 * @see WXYC/Backend-Service#3137
 */

import { closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'album-metadata-reask';

export const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  log('error', 'not_implemented', `${JOB_NAME} is a scaffold; nothing was read or written`);
  process.exitCode = 1;
  await closeLogger();
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run (same
// rationale as `album-metadata-bio-fill#main`).
if (process.env.NODE_ENV !== 'test') {
  void main();
}
