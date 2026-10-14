/**
 * One-shot album-reviews import (BS#3132) — CLI entrypoint. The importable core is `import.ts`.
 *
 *   npx tsx jobs/album-reviews-import/job.ts [--apply]
 *
 * Dry run by default: prints the counts and writes nothing. `--apply` inserts the reviews. Exit 0 on success, 1 on error.
 * Environment: the standard DB_* variables, plus WXYC_SCHEMA_NAME (default `wxyc_schema`). See the README before running.
 */

import { closeDatabaseConnection, createPostgresClient } from '@wxyc/database';
import { runImport } from './import.js';

const USAGE = 'usage: job.ts [--apply]';

const main = async () => {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
  // Strict on purpose: a misspelt flag must stop the run rather than quietly do a dry run the operator took for an apply.
  if (unknown.length > 0) throw new Error(`unknown argument '${unknown[0]}'. ${USAGE}`);
  const apply = process.argv.includes('--apply');
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const sql = createPostgresClient({ applicationName: 'wxyc-album-reviews-import', max: 1 });
  try {
    await runImport(sql, { schema, apply });
  } finally {
    for (const closed of await Promise.allSettled([sql.end(), closeDatabaseConnection()])) {
      if (closed.status === 'rejected') console.error('[album-reviews-import] pool teardown failed:', closed.reason);
    }
  }
};

main().catch((err) => {
  console.error('[album-reviews-import] Fatal error:', err);
  // exitCode, not process.exit(), so buffered log output is flushed before the process ends.
  process.exitCode = 1;
});
