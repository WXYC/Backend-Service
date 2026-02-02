#!/usr/bin/env node

/**
 * Schema Snapshot Loader
 *
 * Loads a schema snapshot into a test database for migration testing.
 *
 * Usage:
 *   node scripts/load-schema-snapshot.mjs [options] <snapshot-file>
 *
 * Options:
 *   --from-s3=KEY      Download snapshot from S3 instead of local file
 *   --drop-existing    Drop existing database and recreate
 *   --target-db=NAME   Target database name (default: wxyc_db_test)
 *
 * Environment:
 *   DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD - Database connection
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION - For S3 download
 *   SNAPSHOT_S3_BUCKET - S3 bucket name
 *
 * Examples:
 *   node scripts/load-schema-snapshot.mjs schema-snapshot.sql
 *   node scripts/load-schema-snapshot.mjs --from-s3=schema-snapshot-latest.sql --drop-existing
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    fromS3: null,
    dropExisting: false,
    targetDb: 'wxyc_db_test',
    file: null,
  };

  for (const arg of args) {
    if (arg.startsWith('--from-s3=')) {
      options.fromS3 = arg.split('=')[1];
    } else if (arg === '--drop-existing') {
      options.dropExisting = true;
    } else if (arg.startsWith('--target-db=')) {
      options.targetDb = arg.split('=')[1];
    } else if (!arg.startsWith('-')) {
      options.file = arg;
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
    adminDb: 'postgres', // Connect to postgres db for admin operations
  };
}

// Download snapshot from S3
async function downloadFromS3(s3Key, localPath) {
  const bucket = process.env.SNAPSHOT_S3_BUCKET || 'wxyc-ci-artifacts';
  const fullKey = s3Key.startsWith('migration-snapshots/') ? s3Key : `migration-snapshots/${s3Key}`;

  console.log(`Downloading s3://${bucket}/${fullKey}...`);

  try {
    execSync(`aws s3 cp "s3://${bucket}/${fullKey}" "${localPath}"`, { stdio: 'inherit' });
    console.log(`Downloaded to ${localPath}`);
  } catch (error) {
    throw new Error(`S3 download failed: ${error.message}`);
  }
}

// Run psql command
function runPsql(dbParams, database, sql) {
  const env = {
    ...process.env,
    PGPASSWORD: dbParams.password,
  };

  const args = ['-h', dbParams.host, '-p', dbParams.port, '-U', dbParams.username, '-d', database, '-c', sql];

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
        resolve(stdout);
      } else {
        reject(new Error(`psql failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run psql: ${err.message}`));
    });
  });
}

// Load snapshot file into database
function loadSnapshot(dbParams, snapshotFile) {
  console.log(`Loading snapshot into ${dbParams.database}...`);

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
    snapshotFile,
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
        reject(new Error(`Failed to load snapshot: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run psql: ${err.message}`));
    });
  });
}

// Check if database exists
async function databaseExists(dbParams) {
  try {
    const result = await runPsql(
      dbParams,
      dbParams.adminDb,
      `SELECT 1 FROM pg_database WHERE datname = '${dbParams.database}'`
    );
    return result.includes('1');
  } catch {
    return false;
  }
}

// Create database
async function createDatabase(dbParams) {
  console.log(`Creating database ${dbParams.database}...`);
  await runPsql(dbParams, dbParams.adminDb, `CREATE DATABASE "${dbParams.database}"`);
}

// Drop database
async function dropDatabase(dbParams) {
  console.log(`Dropping database ${dbParams.database}...`);

  // Terminate existing connections
  try {
    await runPsql(
      dbParams,
      dbParams.adminDb,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbParams.database}' AND pid <> pg_backend_pid()`
    );
  } catch {
    // Ignore errors - database might not exist
  }

  try {
    await runPsql(dbParams, dbParams.adminDb, `DROP DATABASE IF EXISTS "${dbParams.database}"`);
  } catch (error) {
    throw new Error(`Failed to drop database: ${error.message}`);
  }
}

// Main execution
async function main() {
  const options = parseArgs();
  const dbParams = getDbParams(options.targetDb);

  // Determine snapshot file
  let snapshotFile;
  if (options.fromS3) {
    snapshotFile = `/tmp/schema-snapshot-${Date.now()}.sql`;
    await downloadFromS3(options.fromS3, snapshotFile);
  } else if (options.file) {
    snapshotFile = path.resolve(process.cwd(), options.file);
    if (!fs.existsSync(snapshotFile)) {
      throw new Error(`Snapshot file not found: ${snapshotFile}`);
    }
  } else {
    console.log('Usage: node scripts/load-schema-snapshot.mjs [--from-s3=KEY] [--drop-existing] [--target-db=NAME] <snapshot-file>');
    console.log('\nNo snapshot file specified.');
    process.exit(1);
  }

  console.log('\nLoading schema snapshot...\n');
  console.log(`  Snapshot:   ${snapshotFile}`);
  console.log(`  Target:     ${dbParams.host}:${dbParams.port}/${dbParams.database}`);
  console.log(`  Drop first: ${options.dropExisting}`);
  console.log();

  // Handle existing database
  const exists = await databaseExists(dbParams);

  if (exists) {
    if (options.dropExisting) {
      await dropDatabase(dbParams);
    } else {
      console.log(`Database ${dbParams.database} already exists.`);
      console.log('Use --drop-existing to recreate it.');
      process.exit(1);
    }
  }

  // Create fresh database
  await createDatabase(dbParams);

  // Load snapshot
  await loadSnapshot(dbParams, snapshotFile);

  // Cleanup temp file if downloaded from S3
  if (options.fromS3) {
    fs.unlinkSync(snapshotFile);
  }

  console.log(`\nSnapshot loaded successfully into ${dbParams.database}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
