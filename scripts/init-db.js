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

import { config } from 'dotenv';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables (if .env file exists, otherwise use env vars from Docker)
config({ path: join(__dirname, '../.env'), override: false });

const MAX_RETRIES = 30;
const RETRY_DELAY = 1000; // 1 second

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'wxyc_db',
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
};

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
      const sql = postgres({
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        username: dbConfig.username,
        password: dbConfig.password,
        max: 1,
      });
      
      await sql`SELECT 1`;
      await sql.end();
      
      console.log('✅ Database is ready!\n');
      return true;
    } catch (error) {
      if (i === MAX_RETRIES - 1) {
        console.error(`❌ Database not ready after ${MAX_RETRIES} attempts`);
        throw error;
      }
      process.stdout.write(`   Attempt ${i + 1}/${MAX_RETRIES}...\r`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

/**
 * Run Drizzle migrations
 */
async function runMigrations() {
  console.log('🔄 Running Drizzle migrations...');
  
  try {
    const { stdout, stderr } = await execAsync(
      'cd packages/database && npx drizzle-kit migrate',
      { 
        cwd: join(__dirname, '..'),
        env: { ...process.env },
        shell: '/bin/sh'
      }
    );
    
    if (stdout) console.log(stdout);
    if (stderr && !stderr.includes('No config path provided')) console.error(stderr);
    
    console.log('✅ Migrations completed successfully!\n');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

/**
 * Check if database has been seeded
 */
async function isDatabaseSeeded() {
  const sql = postgres({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    username: dbConfig.username,
    password: dbConfig.password,
  });
  
  try {
    // Check if genres table has any data
    const result = await sql`
      SELECT COUNT(*) as count 
      FROM wxyc_schema.genres
    `;
    
    const count = parseInt(result[0].count);
    await sql.end();
    
    return count > 0;
  } catch (error) {
    await sql.end();
    throw error;
  }
}

/**
 * Seed the database
 */
async function seedDatabase() {
  console.log('🌱 Seeding database...');
  
  const sql = postgres({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    username: dbConfig.username,
    password: dbConfig.password,
  });
  
  try {
    const seedSQL = readFileSync(
      join(__dirname, '../dev_env/seed_db.sql'),
      'utf8'
    );
    
    // Execute the seed SQL
    await sql.unsafe(seedSQL);
    await sql.end();
    
    console.log('✅ Database seeded successfully!\n');
  } catch (error) {
    await sql.end();
    console.error('❌ Seeding failed:', error.message);
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
    
    // Step 2: Run migrations
    await runMigrations();
    
    // Step 3: Check if seeding is needed
    const alreadySeeded = await isDatabaseSeeded();
    
    if (alreadySeeded) {
      console.log('ℹ️  Database already contains data, skipping seed.\n');
    } else {
      await seedDatabase();
    }
    
    console.log('🎉 Database initialization complete!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Database initialization failed:', error);
    process.exit(1);
  }
}

main();

