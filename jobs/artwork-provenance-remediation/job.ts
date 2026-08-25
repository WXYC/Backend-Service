/**
 * One-shot drain entrypoint (BS#2258): re-resolve `album_metadata.artwork_url`
 * for every row whose stored artwork is provably a Discogs *artist image* or
 * *label logo* rather than a release cover.
 *
 * The complement of `jobs/flowsheet-artwork-repair` (BS#1209). That drain
 * healed the rows LML's `_resolve_fallback_artwork` bug left null; these are
 * the rows the same bug left wrong and non-null, which #1209's
 * `artwork_url IS NULL` predicate could not reach by construction. As of
 * 2026-08-24 that is 6,977 label logos + 973 artist images out of 41,524
 * artwork-bearing rows.
 *
 * **Run gating.** BS#2258 makes the ordering explicit: do not run this until
 * LML has a path to the covers. Two LML fixes matter, and only the first has
 * shipped:
 *
 *   - LML#1237 (PR#1242, prod 2026-08-23) re-asks Discogs for the bound
 *     release when `artwork_checked_at IS NULL`. Sufficient for the label-logo
 *     cohort — the BS#2258 pilot resolved 120/120 sampled `L-` rows to real
 *     covers against prod carrying this fix, with zero nulls and zero
 *     artist images.
 *   - LML#1241, the sibling-pressing rung, is merged **dark** behind
 *     `LML_RESOLVE_SIBLING_PRESSING_ARTWORK=false` and gates the rows whose
 *     cover lives under a different pressing.
 *
 * Running now is therefore the measured call, not a premature one: the pilot
 * says the dominant cohort heals without #1241, and the writer's rules mean a
 * row that does not heal is left exactly as it was, so a later re-run after
 * the #1241 flip picks it up. Idempotent in both directions.
 *
 * Failure isolation: any LML throw is counted as `error` and skipped; the row
 * keeps its wrong artwork and re-selects on the next run.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { enumerateDiscogsArtwork, runRemediation, selectWrongProvenance } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';
import { remediateAlbum } from './remediate.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'artwork-provenance-remediation';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

/**
 * `DRY_RUN=1` enumerates, classifies, and reports the pre-drain split without
 * asking LML anything or writing a row. BS#2258's data-safety constraint asks
 * for the exact selector's count to be eyeballed before any UPDATE; this is
 * that SELECT, run through the same code the real pass uses rather than a
 * hand-typed approximation of it.
 */
const isDryRun = (): boolean => process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    requireLmlConfigured();
    log('info', 'init', `${JOB_NAME} initialized`);

    const candidates = await enumerateDiscogsArtwork();
    const rows = selectWrongProvenance(candidates);

    if (isDryRun()) {
      log('info', 'dry_run', `${JOB_NAME} dry run; no lookups, no writes`, {
        discogs_artwork_rows: candidates.length,
        selected: rows.length,
      });
      return;
    }

    await runRemediation({
      lookup: lookupMetadata,
      remediate: remediateAlbum,
      rows,
      discogsArtworkRows: candidates.length,
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

// Guard the auto-invoke so the unit suite's module load doesn't fire a stray
// run against the mocked DB. Mirrors `jobs/flowsheet-artwork-repair/job.ts`.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
