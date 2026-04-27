/**
 * Artist Identity ETL: copy reconciled external IDs from LML's
 * `entity.identity` table into Backend-Service's `artists` table.
 *
 * Modes:
 *   node dist/job.js          one-shot incremental (default)
 *   node dist/job.js --poll   continuous polling
 *
 * Matching: exact case-sensitive equality on
 * `entity.identity.library_name = artists.artist_name`. Both sides treat
 * `library_name` as the canonical artist key so exact match covers most
 * real entries; mismatches surface in the run log as unmatched and can
 * inform a follow-up normalization pass.
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
