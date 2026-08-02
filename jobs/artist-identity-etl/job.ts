/**
 * Artist Identity ETL: copy reconciled external IDs from LML's
 * `entity.identity` table into Backend-Service's `artists` table.
 *
 * Modes:
 *   node dist/job.js          one-shot incremental (default)
 *   node dist/job.js --poll   continuous polling
 *
 * Matching: NFC-normalized, otherwise case-sensitive, equality on
 * `entity.identity.library_name = artists.artist_name` (BS#521). Both
 * sides are normalized to Unicode NFC (canonical composition) before
 * comparison, so an LML-supplied name and its `artists` row still match
 * when one is stored in a different composition form (e.g. NFD) -- the
 * dominant defect in the initial full-scan reconciliation match rate
 * (see BS#521). This is deliberately NFC-only: no case-fold, no
 * diacritic-strip, no "The " strip. `artists.artist_name` has no unique
 * constraint, so a broader fold (as the catalog-write matcher applies
 * post-#1897, see #1095) risks COALESCE-ing external ids across two rows
 * a human might be deliberately keeping distinct (e.g. `Wire` vs
 * `WIRE`). NFC normalization alone can't cause that kind of collision --
 * it only collapses byte-distinct encodings of the identical character
 * sequence. Remaining mismatches (case, diacritic-fold, punctuation,
 * etc.) still surface in the run log as unmatched.
 *
 * Update strategy: only fills nulls. Each column on `artists` keeps its
 * existing value if non-null (so any value entered by the library staff
 * wins over an LML-derived one), and conflicts are logged but not
 * applied. This matches #506's "never overwrite human edits" requirement.
 *
 * The per-run loop body lives in `./runIncremental.ts` so unit tests can
 * import and exercise it without spinning up the run() shell below.
 */

import { closeDatabaseConnection, runPollingLoop } from '@wxyc/database';
import { closeLmlConnection } from './fetch-lml.js';
import { runIncremental, JOB_NAME } from './runIncremental.js';

const run = async () => {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--poll')) {
      await runPollingLoop(
        async () => {
          const result = await runIncremental();
          return { hasChanges: result.updated > 0 };
        },
        { jobName: JOB_NAME, notifyPath: '/internal/artist-identity-sync-notify' }
      );
    } else {
      await runIncremental();
    }
  } finally {
    await closeDatabaseConnection();
    await closeLmlConnection();
  }
};

run().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  process.exitCode = 1;
});
