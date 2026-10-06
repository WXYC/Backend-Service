/**
 * One-shot comp-letter backfill (BS#2834) — CLI entrypoint. The importable core is `backfill.ts`.
 *
 *   npx tsx jobs/comp-letter-backfill/job.ts [--apply]
 *
 * Dry run by default: prints the 52 candidate slots, the Rock/Soundtracks V/A slots left unlettered and the gate
 * verdict, and writes nothing. `--apply` writes only if the gate passes.
 * Exit codes: 0 dry run passed / applied / already applied, 1 gate failed or the run errored.
 *
 * Environment: the standard DB_* variables, plus WXYC_SCHEMA_NAME (default `wxyc_schema`). Production is reached
 * through an SSH tunnel to RDS; see the job's README.
 */

import { closeDatabaseConnection, createPostgresClient } from '@wxyc/database';
import { runBackfill } from './backfill.js';

const main = async () => {
  const apply = process.argv.includes('--apply');
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const sql = createPostgresClient({ applicationName: 'wxyc-comp-letter-backfill', max: 1 });
  try {
    const result = await runBackfill(sql, { schema, apply });
    if (result.status === 'aborted') process.exitCode = 1;
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
};

main().catch((err) => {
  console.error('[comp-letter-backfill] Fatal error:', err);
  // exitCode (not exit) so the finally body runs and the pools close.
  process.exitCode = 1;
});
