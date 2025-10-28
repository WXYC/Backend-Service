#!/usr/bin/env node

/**
 * Database Initialization Script
 *
 * This script:
 * 1. Waits for the database to be ready
 * 2. Runs Drizzle migrations to create schema/tables
 * 3. Seeds the database ONLY if it's empty
 *
 * Safe to run multiple times (idempotent)
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

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

console.log(`🔧 Database Init Script Starting...`);
console.log(`   Host: ${dbConfig.host}:${dbConfig.port}`);
console.log(`   Database: ${dbConfig.database}\n`);

/**
 * Wait for database to be ready
 */
async function waitForDatabase() {
  console.log('⏳ Waiting for database to be ready...');

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
  console.log('⬇️ Installing Postgresql Extensions...');

  try {
    const extensionsSQL = readFileSync(join(__dirname, './install_extensions.sql'), 'utf8');

    // Execute the extension install SQL
    await sql.unsafe(extensionsSQL);
  } catch (error) {
    console.error('Extension Install failed:', error.message);
    throw error;
  }
}

/**
 * Run Drizzle migrations
 */
async function runMigrations() {
  console.log('🔄 Running Drizzle migrations...');

  try {
    const { stdout, stderr } = await execAsync('npm run drizzle:migrate', {
      env: { ...process.env },
      shell: '/bin/sh',
    });

    if (stdout) console.log(stdout);
    if (stderr && !stderr.includes('No config path provided')) console.error(stderr);

    console.log('Migrations completed successfully!\n');
  } catch (error) {
    console.error('Migration failed:', error.message);
    throw error;
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
 * Seed the database
 */
async function seedDatabase() {
  console.log('🌱 Seeding database...');

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

    // Step 4: Check if seeding is needed
    const alreadySeeded = await isDatabaseSeeded();

    if (alreadySeeded) {
      console.log('Database already contains data, skipping seed.\n');
    } else {
      await seedDatabase();
    }

    console.log('Database initialization complete!\n');
    sql.end();
    process.exit(0);
  } catch (error) {
    console.error('\nDatabase initialization failed:', error);
    sql.end();
    process.exit(1);
  }
}

main();
