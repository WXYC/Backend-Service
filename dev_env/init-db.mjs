#!/usr/bin/env node

/**
 * Database Initialization Script
 *
 * This script:
 * 1. Waits for the database to be ready
 * 2. Runs Drizzle migrations to create schema/tables
 * 3. Verifies all journal migrations were applied (catches silent skips)
 * 4. Seeds the database ONLY if it's empty
 *
 * Safe to run multiple times (idempotent)
 */

import postgres from 'postgres';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { styleText } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { formatPgError } from './format-pg-error.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_RETRIES = 30;
const RETRY_DELAY = 1000; // 1 second

const dbConfig = {
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'wxyc_db',
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  max: 1,
  // postgres-js dumps every NOTICE to stderr by default. Migrations like
  // `DROP INDEX IF EXISTS` legitimately produce many ("index X does not
  // exist, skipping"). On the success path that noise drowns the only
  // line that matters ("All N migrations verified as applied"); on the
  // failure path formatPgError() carries the error fields anyway. Drop
  // notices here.
  onnotice: () => {},
};

const sql = postgres(dbConfig);

console.log(styleText(['bold'], `🔧 Database Init Script Starting...`));
console.log(`   Host: ${dbConfig.host}:${dbConfig.port}`);
console.log(`   Database: ${dbConfig.database}\n`);

/**
 * Wait for database to be ready
 */
async function waitForDatabase() {
  console.log(styleText(['bold'], '⏳ Waiting for database to be ready...\n'));

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await sql`SELECT 1`;

      console.log('Database is ready!\n');
      return true;
    } catch (error) {
      if (i === MAX_RETRIES - 1) {
        console.error(`Database not ready after ${MAX_RETRIES} attempts`);
        throw error;
      }
      process.stdout.write(`   Attempt ${i + 1}/${MAX_RETRIES}...\r`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

async function installExtensions() {
  console.log(styleText(['bold'], '🛠️  Installing Postgresql Extensions..\n'));

  try {
    const extensionsSQL = readFileSync(join(__dirname, './install_extensions.sql'), 'utf8');

    // Execute the extension install SQL
    await sql.unsafe(extensionsSQL);
    console.log('Installed psql extensions successfully!\n');
  } catch (error) {
    // Extension already exists is not a fatal error (code 42710)
    // This can happen if the database was previously initialized
    if (error.code === '42710') {
      console.log('Extensions already exist, skipping installation.\n');
    } else {
      console.error('Extension Install failed:', error.message);
      throw error; // Re-throw non-extension-exists errors
    }
  }
}

/**
 * Run Drizzle migrations.
 *
 * Calls drizzle-orm's programmatic migrate() directly instead of shelling out
 * to `drizzle-kit migrate`. The CLI buffers Postgres ERROR text behind a
 * spinner, so on failure the deploy log shows only trailing NOTICE lines and
 * the operator has to guess the cause (incidents #400, #550, run 25337297761).
 * The library version surfaces the full error object — code, severity,
 * message, where (PL/pgSQL stack frame), detail, hint, etc. — via
 * formatPgError so the deploy log carries enough to act on.
 */
async function runMigrations() {
  console.log(styleText(['bold'], '🔄 Running Drizzle migrations...'));

  const migrationsDir = process.env.MIGRATION_LOC || join(__dirname, '..', 'shared/database/src/migrations');
  const db = drizzle(sql);

  try {
    await migrate(db, { migrationsFolder: migrationsDir });
    console.log('\nMigrations completed successfully!\n');
  } catch (error) {
    process.stderr.write('\n');
    process.stderr.write(formatPgError(error));
    throw error;
  }
}

/**
 * Verify that all journal migrations were applied to the database.
 *
 * Drizzle's migration runner uses a timestamp comparison that silently skips
 * migrations with out-of-order timestamps. This function provides an
 * independent check by comparing SHA-256 hashes of migration SQL files against
 * the hashes recorded in drizzle.__drizzle_migrations.
 */
/**
 * Tags whose hashes will never be in `drizzle.__drizzle_migrations` because
 * drizzle's "max(applied.created_at) cursor" silently skipped them and a
 * later replay migration carries their effects forward. The replays apply
 * cleanly; the originals stay in the journal so their SQL is on disk and
 * the validator's "missing SQL" check stays satisfied. See #511 + #550.
 *
 * Each entry must include the migration that *replays* it so future
 * audit tooling can trace cause and effect without grepping git history.
 */
const HISTORICAL_REPLACED_TAGS = new Map([
  ['0054_flowsheet-search-doc-with-dj-name', '0065_replay-flowsheet-search-doc-with-dj-name'],
  ['0064_propagate-v012-mojibake', '0066_replay-v012-mojibake'],
]);

async function verifyMigrations() {
  console.log(styleText(['bold'], '🔍 Verifying migration completeness...\n'));

  // MIGRATION_LOC is set in Dockerfile.migrate (/init/database/migrations).
  // When running outside Docker (CI, local dev), fall back to the repo path.
  const migrationsDir = process.env.MIGRATION_LOC || join(__dirname, '..', 'shared/database/src/migrations');
  const journalPath = join(migrationsDir, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));

  // Compute expected hashes from journal SQL files
  const expectedMigrations = [];
  for (const entry of journal.entries) {
    const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
    const sqlContent = readFileSync(sqlPath, 'utf8');
    const hash = crypto.createHash('sha256').update(sqlContent).digest('hex');
    expectedMigrations.push({ tag: entry.tag, idx: entry.idx, when: entry.when, hash });
  }

  // Query all applied migrations from DB
  const dbMigrations = await sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC
  `;
  const appliedHashes = new Set(dbMigrations.map((m) => m.hash));

  // Check for missing migrations, partitioning into "actual misses" (a real
  // failure to apply) and "expected absent" (cursor-skipped, replayed by a
  // later migration that *did* apply).
  const allMissing = expectedMigrations.filter((m) => !appliedHashes.has(m.hash));
  const expectedAbsent = [];
  const realMissing = [];
  for (const m of allMissing) {
    if (HISTORICAL_REPLACED_TAGS.has(m.tag)) {
      const replayTag = HISTORICAL_REPLACED_TAGS.get(m.tag);
      const replay = expectedMigrations.find((e) => e.tag === replayTag);
      // Only treat as expected-absent if the replay itself *did* apply.
      // Otherwise the hole is real and the operator should know.
      if (replay && appliedHashes.has(replay.hash)) {
        expectedAbsent.push({ ...m, replayTag });
      } else {
        realMissing.push(m);
      }
    } else {
      realMissing.push(m);
    }
  }

  for (const m of expectedAbsent) {
    console.warn(
      `WARN:  Journal entry idx ${m.idx} (${m.tag}) has no row in __drizzle_migrations ` +
        `(allowlisted: replayed by ${m.replayTag}).`
    );
  }

  if (realMissing.length > 0) {
    console.error('MIGRATION VERIFICATION FAILED!');
    console.error(`${realMissing.length} migration(s) have no matching hash in __drizzle_migrations:\n`);
    for (const m of realMissing) {
      console.error(`  - [idx ${m.idx}] ${m.tag} (when: ${m.when})`);
    }
    console.error('\nTwo causes are possible — investigate in this order:\n');
    console.error('  1. Hash drift on an applied migration. The .sql file was edited');
    console.error('     after prod applied it (often a retroactive comment or guard');
    console.error("     addition), so the file's SHA-256 no longer matches the row");
    console.error('     prod stored. PR-time check `npm run lint:migrations` (Check 11)');
    console.error('     catches this; if it slipped through, revert the offending edit');
    console.error('     and move the documentation into');
    console.error('     shared/database/src/migrations/PRECONDITION_NOTES.md.');
    console.error('     See: WXYC/Backend-Service#705 follow-up.\n');
    console.error("  2. Out-of-order `when` timestamp in _journal.json. Drizzle's");
    console.error('     runtime migrator silently skips entries whose `when` is at or');
    console.error('     below max(__drizzle_migrations.created_at). The recipe is to');
    console.error('     bump the offending entry to (previous_entry.when + 1).');
    console.error('     See: WXYC/Backend-Service#400, #550.\n');
    throw new Error(`Migration verification failed: ${realMissing.length} missing migration(s)`);
  }

  // Warn about out-of-order timestamps (prevention for future)
  let prevWhen = 0;
  let prevTag = '';
  for (const entry of journal.entries) {
    if (entry.when <= prevWhen) {
      console.warn(`⚠️  WARNING: Journal entry idx ${entry.idx} (${entry.tag}) has out-of-order timestamp!`);
      console.warn(`   when=${entry.when} is not greater than previous when=${prevWhen} (${prevTag})`);
      console.warn('   This WILL cause migrations to be silently skipped.\n');
    }
    prevWhen = entry.when;
    prevTag = entry.tag;
  }

  const appliedCount = expectedMigrations.length - expectedAbsent.length;
  if (expectedAbsent.length > 0) {
    console.log(
      `${appliedCount} of ${expectedMigrations.length} migrations applied; ` +
        `${expectedAbsent.length} expected absent (allowlisted, see HISTORICAL_REPLACED_TAGS).\n`
    );
  } else {
    console.log(`All ${expectedMigrations.length} migrations verified as applied.\n`);
  }
}

/**
 * Check if database has been seeded
 */
async function isDatabaseSeeded() {
  try {
    // Check if genres table has any data
    const result = await sql`
      SELECT COUNT(*) as count 
      FROM wxyc_schema.genres
    `;

    const count = parseInt(result[0].count);

    return count > 0;
  } catch (error) {
    throw error;
  }
}

/**
 * Seed the database inside an explicit transaction.
 *
 * The seed file contains many statements. Running them via sql.unsafe() in
 * the simple query protocol means each statement auto-commits independently.
 * If an intermediate statement fails, the postgres library may not surface the
 * error, leaving the database partially seeded while the script reports success.
 *
 * Wrapping in sql.begin() ensures atomicity: either every statement commits
 * or the entire batch rolls back, and any error is properly propagated.
 */
async function seedDatabase() {
  console.log(styleText(['bold'], '🌱 Seeding database...\n'));

  const seedSQL = readFileSync(join(__dirname, './seed_db.sql'), 'utf8');

  await sql.begin(async (tx) => {
    await tx.unsafe(seedSQL);
  });

  console.log('Database seeded successfully!\n');
}

/**
 * Verify that critical seed data was persisted.
 *
 * Catches silent failures where the seed appears to succeed but no rows
 * were actually committed (the original bug reported in #408).
 */
async function verifySeedData() {
  console.log(styleText(['bold'], '🔍 Verifying seed data...\n'));

  const counts = await sql`
    SELECT
      (SELECT COUNT(*) FROM auth_user) AS users,
      (SELECT COUNT(*) FROM auth_account) AS accounts,
      (SELECT COUNT(*) FROM auth_member) AS members,
      (SELECT COUNT(*) FROM wxyc_schema.genres) AS genres,
      (SELECT COUNT(*) FROM wxyc_schema.artists) AS artists
  `;

  const { users, accounts, members, genres, artists } = counts[0];
  console.log(`   auth_user:    ${users} rows`);
  console.log(`   auth_account: ${accounts} rows`);
  console.log(`   auth_member:  ${members} rows`);
  console.log(`   genres:       ${genres} rows`);
  console.log(`   artists:      ${artists} rows\n`);

  if (parseInt(users) === 0 || parseInt(genres) === 0) {
    throw new Error(
      'Seed verification failed: critical tables are empty after seeding. ' +
        'The seed SQL may have been silently rolled back.'
    );
  }
}

/**
 * Main initialization flow
 */
async function main() {
  try {
    // Step 1: Wait for database
    await waitForDatabase();

    // Step 2: Install Extensions
    await installExtensions();

    // Step 3: Run migrations
    await runMigrations();

    // Step 4: Verify all migrations were applied
    await verifyMigrations();

    // Step 5: Check if seeding should be skipped (production) or if already seeded
    const skipSeed = process.env.SKIP_SEED === 'true';

    if (skipSeed) {
      console.log('SKIP_SEED is set, skipping database seeding.\n');
    } else {
      const alreadySeeded = await isDatabaseSeeded();

      if (alreadySeeded) {
        console.log('Database already contains data, skipping seed.\n');
      } else {
        await seedDatabase();
        await verifySeedData();
      }
    }

    console.log(styleText(['bold'], '💾 Database initialization complete!'));
    await sql.end();
    process.exit(0);
  } catch (error) {
    console.error('\nDatabase initialization failed:', error);
    await sql.end();
    process.exit(1);
  }
}

main();
