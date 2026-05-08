#!/usr/bin/env node

/**
 * Pre-flight migration dry-run for the migrate-dryrun CI job (#726).
 *
 * Runs drizzle-orm's programmatic migrate() against whatever DB the env
 * vars point at, then exits 0 on success or 1 on failure. On failure, the
 * shared formatPgError helper from #725 dumps the underlying Postgres
 * error fields (severity, code, where, etc.) to stderr so a reviewer can
 * act on the failure without rerunning anything.
 *
 * Why this is a separate script and not `node dev_env/init-db.mjs`:
 * init-db.mjs runs extension installation, journal verification, and
 * optional seeding. All of those are benign against a snapshot, but each
 * is a chance for a non-migration failure to mask the signal we care
 * about. A purpose-built script keeps the failure surface narrow — if the
 * dry-run exits non-zero, the migration itself is the cause.
 *
 * The snapshot already has all extensions installed, so installExtensions
 * is unnecessary. Verify-journal still runs on the deploy path via
 * init-db.mjs; not duplicating it here. Seeding wouldn't fire anyway
 * because the snapshot has data.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { formatPgError } from '../dev_env/format-pg-error.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sql = postgres({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  max: 1,
  // Suppress NOTICE noise on the success path; on failure, formatPgError
  // surfaces the diagnostic fields anyway.
  onnotice: () => {},
});

try {
  const db = drizzle(sql);
  await migrate(db, {
    migrationsFolder: join(__dirname, '../shared/database/src/migrations'),
  });
  // TEMP #757-validation: force failure to exercise the always() teardown.
  // Will be reverted in the next commit on this branch.
  if (process.env) {
    throw new Error('test JIT teardown — synthetic failure for #757 validation');
  }
  console.log('dryrun-migrate: ok');
} catch (error) {
  process.stderr.write('\n');
  process.stderr.write(formatPgError(error));
  process.exitCode = 1;
} finally {
  await sql.end();
}
