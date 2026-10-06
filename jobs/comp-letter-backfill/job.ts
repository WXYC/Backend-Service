/**
 * One-shot comp-letter backfill (BS#2834) — CLI entrypoint. The importable core is `backfill.ts`.
 *
 *   npx tsx jobs/comp-letter-backfill/job.ts [--dump <wxycmusic-backup.sql.gz>] [--apply]
 *
 * Dry run by default: prints the 52 candidate slots, the Rock/Soundtracks V/A slots left unlettered, the advisory
 * cross-check (with `--dump`) and the gate verdict, and writes nothing. `--apply` writes only if the gate passes.
 * Exit codes: 0 dry run passed / applied / already applied, 1 gate failed or the run errored. An error logged after
 * `COMMITTED` (from ANALYZE or teardown) still exits 1, but the letters have landed; see the README.
 *
 * Environment: the standard DB_* variables, plus WXYC_SCHEMA_NAME (default `wxyc_schema`). Production is reached
 * through an SSH tunnel to RDS; see the job's README.
 */

import { closeDatabaseConnection, createPostgresClient } from '@wxyc/database';
import { parseArgs } from './args.js';
import { runBackfill } from './backfill.js';
import { readLegacyReleases } from './legacy.js';

const main = async () => {
  const { apply, dump } = parseArgs(process.argv.slice(2));
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const sql = createPostgresClient({ applicationName: 'wxyc-comp-letter-backfill', max: 1 });
  try {
    let legacyReleases;
    if (dump) {
      console.log(`[comp-letter-backfill] reading LIBRARY_CODE + LIBRARY_RELEASE from ${dump}`);
      legacyReleases = await readLegacyReleases(dump);
      console.log(`[comp-letter-backfill] ${legacyReleases.size} legacy releases read from the dump`);
    }
    const result = await runBackfill(sql, { schema, apply, legacyReleases });
    if (result.status === 'aborted') process.exitCode = 1;
  } finally {
    // Close both pools even if one refuses, and log a teardown failure without letting it replace the run's own error.
    for (const closed of await Promise.allSettled([sql.end(), closeDatabaseConnection()])) {
      if (closed.status === 'rejected') console.error('[comp-letter-backfill] pool teardown failed:', closed.reason);
    }
  }
};

main().catch((err) => {
  console.error('[comp-letter-backfill] Fatal error:', err);
  // exitCode, not process.exit(), so buffered log output is flushed before the process ends.
  process.exitCode = 1;
});
