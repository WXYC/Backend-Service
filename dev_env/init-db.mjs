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
import { exec } from 'child_process';
import { promisify } from 'util';
import { styleText } from 'node:util';

const execAsync = promisify(exec);
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
};

const sql = postgres(dbConfig);

const bold = 'font-weight: strong;';

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
 * Run Drizzle migrations
 */
async function runMigrations() {
  console.log(styleText(['bold'], '🔄 Running Drizzle migrations...'));

  try {
    const { stdout, stderr } = await execAsync('npm run drizzle:migrate', {
      env: { ...process.env },
      shell: '/bin/sh',
    });

    if (stdout) console.log(stdout);
    if (stderr && !stderr.includes('No config path provided')) console.error(stderr);

    console.log('\nMigrations completed successfully!\n');
  } catch (error) {
    console.error('Migration failed:', error.message);
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
async function verifyMigrations() {
  console.log(styleText(['bold'], '🔍 Verifying migration completeness...\n'));

  const migrationsDir = join(__dirname, 'database/migrations');
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

  // Check for missing migrations
  const missing = expectedMigrations.filter((m) => !appliedHashes.has(m.hash));

  if (missing.length > 0) {
    console.error('MIGRATION VERIFICATION FAILED!');
    console.error(`${missing.length} migration(s) were NOT applied:\n`);
    for (const m of missing) {
      console.error(`  - [idx ${m.idx}] ${m.tag} (when: ${m.when})`);
    }
    console.error('\nThis likely indicates an out-of-order timestamp in _journal.json.');
    console.error('The "when" timestamps MUST be monotonically increasing.');
    console.error('See: https://github.com/WXYC/Backend-Service/issues/400\n');
    throw new Error(`Migration verification failed: ${missing.length} missing migration(s)`);
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

  console.log(`All ${expectedMigrations.length} migrations verified as applied.\n`);
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
 * Seed the database
 */
async function seedDatabase() {
  console.log(styleText(['bold'], '🌱 Seeding database...\n'));

  try {
    const seedSQL = readFileSync(join(__dirname, './seed_db.sql'), 'utf8');

    // Execute the seed SQL
    await sql.unsafe(seedSQL);
    await sql.end();

    console.log('Database seeded successfully!\n');
  } catch (error) {
    await sql.end();
    console.error('Seeding failed:', error.message);
    throw error;
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
      }
    }

    console.log(styleText(['bold'], '💾 Database initialization complete!'));
    sql.end();
    process.exit(0);
  } catch (error) {
    console.error('\nDatabase initialization failed:', error);
    sql.end();
    process.exit(1);
  }
}

main();
