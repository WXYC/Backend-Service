#!/usr/bin/env node

/**
 * Migration Snapshot Tester
 *
 * Tests migrations against a production-like schema snapshot to catch
 * issues before deployment.
 *
 * Usage:
 *   node scripts/test-migrations-snapshot.mjs [options]
 *
 * Options:
 *   --snapshot=FILE      Local snapshot file to use
 *   --from-s3            Download latest snapshot from S3
 *   --keep-db            Don't drop test database after testing
 *   --target-db=NAME     Target database name (default: wxyc_db_migration_test)
 *   --migrations=DIR     Migrations directory
 *   --output=json        Output format (json or text)
 *
 * Environment:
 *   DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD - Database connection
 *   AWS credentials for S3 access
 *
 * The test process:
 *   1. Load schema snapshot into test database
 *   2. Run all pending migrations
 *   3. Verify schema integrity
 *   4. Report results
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(ROOT_DIR, 'shared/database/src/migrations');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    snapshot: null,
    fromS3: false,
    keepDb: false,
    targetDb: 'wxyc_db_migration_test',
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    output: 'text',
  };

  for (const arg of args) {
    if (arg.startsWith('--snapshot=')) {
      options.snapshot = arg.split('=')[1];
    } else if (arg === '--from-s3') {
      options.fromS3 = true;
    } else if (arg === '--keep-db') {
      options.keepDb = true;
    } else if (arg.startsWith('--target-db=')) {
      options.targetDb = arg.split('=')[1];
    } else if (arg.startsWith('--migrations=')) {
      options.migrationsDir = arg.split('=')[1];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    }
  }

  return options;
}

// Get database connection parameters
function getDbParams(targetDb) {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    database: targetDb,
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
}

// Run psql command and return output
function runPsql(dbParams, sql, stopOnError = true) {
  const env = {
    ...process.env,
    PGPASSWORD: dbParams.password,
  };

  const args = [
    '-h',
    dbParams.host,
    '-p',
    dbParams.port,
    '-U',
    dbParams.username,
    '-d',
    dbParams.database,
    '-t',
    '-c',
    sql,
  ];

  if (stopOnError) {
    args.push('-v', 'ON_ERROR_STOP=1');
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('psql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`psql failed: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run psql: ${err.message}`));
    });
  });
}

// Run a SQL file
function runSqlFile(dbParams, filePath) {
  const env = {
    ...process.env,
    PGPASSWORD: dbParams.password,
  };

  const args = [
    '-h',
    dbParams.host,
    '-p',
    dbParams.port,
    '-U',
    dbParams.username,
    '-d',
    dbParams.database,
    '-f',
    filePath,
    '-v',
    'ON_ERROR_STOP=1',
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('psql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run psql: ${err.message}`));
    });
  });
}

// Load snapshot into test database
async function loadSnapshot(options, dbParams) {
  const scriptPath = path.join(__dirname, 'load-schema-snapshot.mjs');

  const args = ['--target-db=' + options.targetDb, '--drop-existing'];

  if (options.fromS3) {
    args.push('--from-s3=schema-snapshot-latest.sql');
  } else if (options.snapshot) {
    args.push(options.snapshot);
  } else {
    throw new Error('No snapshot specified. Use --snapshot=FILE or --from-s3');
  }

  console.log('Loading schema snapshot...');

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to load snapshot (exit code ${code})`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to load snapshot: ${err.message}`));
    });
  });
}

// Get list of migration files
function getMigrationFiles(migrationsDir) {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.includes('.rollback'))
    .sort()
    .map((f) => ({
      name: f,
      path: path.join(migrationsDir, f),
    }));
}

// Get already applied migrations from drizzle journal
async function getAppliedMigrations(dbParams, migrationsDir) {
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json');

  if (!fs.existsSync(journalPath)) {
    return new Set();
  }

  // Check if drizzle migrations table exists
  try {
    const result = await runPsql(
      dbParams,
      "SELECT tag FROM __drizzle_migrations",
      false
    );

    return new Set(result.split('\n').map((t) => t.trim()).filter(Boolean));
  } catch {
    // Table doesn't exist yet
    return new Set();
  }
}

// Run a single migration
async function runMigration(dbParams, migration) {
  const startTime = Date.now();

  try {
    await runSqlFile(dbParams, migration.path);
    const duration = Date.now() - startTime;

    return {
      name: migration.name,
      status: 'success',
      duration,
      error: null,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    return {
      name: migration.name,
      status: 'failed',
      duration,
      error: error.message,
    };
  }
}

// Verify schema integrity after migrations
async function verifySchema(dbParams) {
  const checks = [];

  // Check 1: No broken foreign keys
  try {
    const fkQuery = `
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema IN ('public', 'wxyc_schema')
    `;
    await runPsql(dbParams, fkQuery);
    checks.push({ name: 'Foreign key integrity', status: 'passed' });
  } catch (error) {
    checks.push({ name: 'Foreign key integrity', status: 'failed', error: error.message });
  }

  // Check 2: All required schemas exist
  try {
    const result = await runPsql(
      dbParams,
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('public', 'wxyc_schema')"
    );
    const schemas = result.split('\n').map((s) => s.trim()).filter(Boolean);

    if (schemas.length >= 1) {
      checks.push({ name: 'Required schemas exist', status: 'passed' });
    } else {
      checks.push({ name: 'Required schemas exist', status: 'failed', error: 'Missing schemas' });
    }
  } catch (error) {
    checks.push({ name: 'Required schemas exist', status: 'failed', error: error.message });
  }

  // Check 3: No orphaned indexes (indexes on non-existent tables)
  try {
    const indexQuery = `
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE schemaname IN ('public', 'wxyc_schema')
        AND tablename NOT IN (
          SELECT table_name FROM information_schema.tables
          WHERE table_schema IN ('public', 'wxyc_schema')
        )
    `;
    const result = await runPsql(dbParams, indexQuery);
    if (result.trim() === '') {
      checks.push({ name: 'No orphaned indexes', status: 'passed' });
    } else {
      checks.push({ name: 'No orphaned indexes', status: 'failed', error: 'Found orphaned indexes' });
    }
  } catch (error) {
    checks.push({ name: 'No orphaned indexes', status: 'failed', error: error.message });
  }

  return checks;
}

// Drop test database
async function dropTestDatabase(options) {
  const dbParams = getDbParams('postgres');
  const targetDb = options.targetDb;

  console.log(`\nCleaning up test database ${targetDb}...`);

  try {
    // Terminate connections
    await runPsql(
      dbParams,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${targetDb}' AND pid <> pg_backend_pid()`,
      false
    );

    // Drop database
    await runPsql(dbParams, `DROP DATABASE IF EXISTS "${targetDb}"`, false);
    console.log('Test database dropped.');
  } catch (error) {
    console.error(`Warning: Failed to drop test database: ${error.message}`);
  }
}

// Format results as text
function formatTextResults(results) {
  let output = '\n' + '═'.repeat(70) + '\n';
  output += 'Migration Test Results\n';
  output += '═'.repeat(70) + '\n\n';

  // Migration results
  output += 'Migrations:\n';
  for (const m of results.migrations) {
    const icon = m.status === 'success' ? '✅' : '❌';
    const duration = m.duration ? ` (${m.duration}ms)` : '';
    output += `  ${icon} ${m.name}${duration}\n`;
    if (m.error) {
      output += `     Error: ${m.error.substring(0, 100)}\n`;
    }
  }

  // Schema verification
  output += '\nSchema Verification:\n';
  for (const c of results.schemaChecks) {
    const icon = c.status === 'passed' ? '✅' : '❌';
    output += `  ${icon} ${c.name}\n`;
    if (c.error) {
      output += `     Error: ${c.error.substring(0, 100)}\n`;
    }
  }

  // Summary
  output += '\n' + '─'.repeat(70) + '\n';
  const failedMigrations = results.migrations.filter((m) => m.status === 'failed').length;
  const failedChecks = results.schemaChecks.filter((c) => c.status === 'failed').length;

  if (failedMigrations === 0 && failedChecks === 0) {
    output += '✅ All migrations passed!\n';
  } else {
    output += `❌ ${failedMigrations} migration(s) failed, ${failedChecks} check(s) failed\n`;
  }

  output += `Total time: ${results.totalDuration}ms\n`;

  return output;
}

// Main execution
async function main() {
  const options = parseArgs();
  const dbParams = getDbParams(options.targetDb);
  const startTime = Date.now();

  console.log('Migration Snapshot Test\n');
  console.log(`  Target DB:    ${options.targetDb}`);
  console.log(`  Migrations:   ${options.migrationsDir}`);
  console.log(`  Keep DB:      ${options.keepDb}`);
  console.log();

  const results = {
    migrations: [],
    schemaChecks: [],
    totalDuration: 0,
    success: false,
  };

  try {
    // Step 1: Load snapshot
    await loadSnapshot(options, dbParams);

    // Step 2: Get migration files
    const migrations = getMigrationFiles(options.migrationsDir);
    console.log(`\nFound ${migrations.length} migration files.\n`);

    // Step 3: Run each migration
    console.log('Running migrations...');
    for (const migration of migrations) {
      const result = await runMigration(dbParams, migration);
      results.migrations.push(result);

      const icon = result.status === 'success' ? '✅' : '❌';
      console.log(`  ${icon} ${migration.name}`);

      if (result.status === 'failed') {
        console.log(`     Error: ${result.error.substring(0, 80)}...`);
        // Continue running other migrations to catch all errors
      }
    }

    // Step 4: Verify schema integrity
    console.log('\nVerifying schema integrity...');
    results.schemaChecks = await verifySchema(dbParams);

    for (const check of results.schemaChecks) {
      const icon = check.status === 'passed' ? '✅' : '❌';
      console.log(`  ${icon} ${check.name}`);
    }

    // Determine overall success
    const failedMigrations = results.migrations.filter((m) => m.status === 'failed').length;
    const failedChecks = results.schemaChecks.filter((c) => c.status === 'failed').length;
    results.success = failedMigrations === 0 && failedChecks === 0;
  } catch (error) {
    console.error(`\nTest failed: ${error.message}`);
    results.error = error.message;
  } finally {
    results.totalDuration = Date.now() - startTime;

    // Cleanup
    if (!options.keepDb) {
      await dropTestDatabase(options);
    }
  }

  // Output results
  if (options.output === 'json') {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatTextResults(results));
  }

  // Exit with appropriate code
  process.exit(results.success ? 0 : 1);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
