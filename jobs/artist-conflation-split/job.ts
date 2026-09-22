/**
 * One-shot split: restore confirmed-distinct acts merged onto shared
 * `artists` rows (BS#2645). CLI entrypoint — the importable core lives in
 * `split.ts` so the destructive functions can be tested against a real
 * Postgres without this module's `main()` auto-run firing on import.
 *
 * Input is the release-tie audit's directives file
 * (WXYC/catalog-audits#30 `split-directives.tsv`), passed explicitly:
 *
 *   node dist/job.js --directives /path/to/split-directives.tsv            # dry-run
 *   node dist/job.js --directives /path/to/split-directives.tsv --execute  # write
 *
 * DATA SAFETY / ops (docs/bulk-update-playbook.md):
 *   - Dry-run by default; `--execute` opts into writes. Dry-run logs each
 *     directive's affected set (crossreference code, library rows per genre,
 *     rows left on the shared id for the operator) with zero writes.
 *   - Validation refuses rather than guesses; a completed directive
 *     re-validates as already-applied on a re-run and is skipped, so the job
 *     is idempotent.
 *   - Each directive runs in a single transaction (re-validated inside it).
 *   - DEPLOY ORDER: the identity-ETL ambiguity guard (BS#2644) must be live
 *     first, or the next ETL run fills both same-named rows with the same
 *     name-keyed id — re-merging the identities this job just separated.
 *
 * Environment: standard DB_* connection vars (same as the other one-shots).
 */

import { readFileSync } from 'fs';
import { closeDatabaseConnection } from '@wxyc/database';
import { parseDirectives, runSplit } from './split.js';

const main = async () => {
  try {
    const args = process.argv.slice(2);
    const flagIndex = args.indexOf('--directives');
    const path = flagIndex !== -1 ? args[flagIndex + 1] : undefined;
    if (!path) {
      throw new Error('Usage: job.js --directives <split-directives.tsv> [--execute]');
    }
    const directives = parseDirectives(readFileSync(path, 'utf8'));
    await runSplit(directives);
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((err) => {
  console.error('[artist-split] Fatal error:', err);
  // exitCode (not exit) so the finally body runs and the pg pool closes.
  process.exitCode = 1;
});
