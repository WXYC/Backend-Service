#!/usr/bin/env node

/**
 * One-time audit of the drizzle.__drizzle_migrations table against the
 * migration journal. Reports orphaned DB rows, missing rows, and timestamp
 * mismatches.
 *
 * Usage:
 *   node scripts/audit-migrations.mjs              # dry-run (report only)
 *   node scripts/audit-migrations.mjs --fix        # apply fixes in a transaction
 *
 * Requires DB_HOST, DB_NAME, DB_USERNAME, DB_PASSWORD env vars (or .env via dotenvx).
 *
 * See: https://github.com/WXYC/Backend-Service/issues/400
 */

import postgres from 'postgres';
import crypto from 'crypto';
import { readFileSync } from 'fs';

const fix = process.argv.includes('--fix');

const sql = postgres({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'wxyc_db',
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  max: 1,
});

const journalPath = 'shared/database/src/migrations/meta/_journal.json';
const migrationsDir = 'shared/database/src/migrations';

try {
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));

  // Build expected hashes from journal
  const expected = new Map();
  for (const entry of journal.entries) {
    const sqlContent = readFileSync(`${migrationsDir}/${entry.tag}.sql`, 'utf8');
    const hash = crypto.createHash('sha256').update(sqlContent).digest('hex');
    expected.set(hash, { tag: entry.tag, idx: entry.idx, when: entry.when });
  }

  // Query DB
  const dbRows = await sql`
    SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC
  `;

  console.log(`Journal entries: ${expected.size}`);
  console.log(`DB rows:         ${dbRows.length}\n`);

  // Find orphaned rows (in DB but not in journal)
  const orphanedRows = [];
  for (const row of dbRows) {
    if (!expected.has(row.hash)) {
      orphanedRows.push(row);
      console.log(
        `ORPHANED:  id=${row.id}  created_at=${row.created_at} (${new Date(Number(row.created_at)).toISOString().split('T')[0]})  hash=${row.hash.slice(0, 16)}...`
      );
    }
  }

  // Find missing rows (in journal but not in DB)
  const dbHashes = new Set(dbRows.map((r) => r.hash));
  const missingEntries = [];
  for (const [hash, entry] of expected) {
    if (!dbHashes.has(hash)) {
      missingEntries.push({ hash, ...entry });
      console.log(`MISSING:   idx=${entry.idx}  ${entry.tag}  hash=${hash.slice(0, 16)}...`);
    }
  }

  // Find timestamp mismatches (in both, but created_at != when)
  const timestampFixes = [];
  for (const row of dbRows) {
    const entry = expected.get(row.hash);
    if (entry && Number(row.created_at) !== entry.when) {
      timestampFixes.push({
        id: row.id,
        hash: row.hash,
        oldCreatedAt: row.created_at,
        newCreatedAt: entry.when,
        tag: entry.tag,
      });
      console.log(`TIMESTAMP: idx=${entry.idx}  ${entry.tag}  DB=${row.created_at} -> journal=${entry.when}`);
    }
  }

  // Summary
  console.log(`\nOrphaned rows:        ${orphanedRows.length}`);
  console.log(`Missing rows:         ${missingEntries.length}`);
  console.log(`Timestamp mismatches: ${timestampFixes.length}`);

  if (orphanedRows.length === 0 && missingEntries.length === 0 && timestampFixes.length === 0) {
    console.log('\nNo issues found. DB and journal are in sync.');
    await sql.end();
    process.exit(0);
  }

  if (!fix) {
    console.log('\nRun with --fix to apply changes.');
    await sql.end();
    process.exit(1);
  }

  // Apply fixes in a single transaction
  console.log('\nApplying fixes...');

  await sql.begin(async (tx) => {
    // Delete orphaned rows
    for (const row of orphanedRows) {
      await tx`DELETE FROM drizzle.__drizzle_migrations WHERE id = ${row.id}`;
      console.log(`  Deleted orphaned row id=${row.id}`);
    }

    // Insert missing rows
    for (const entry of missingEntries) {
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${entry.hash}, ${entry.when})
      `;
      console.log(`  Inserted missing migration: ${entry.tag}`);
    }

    // Fix timestamps
    for (const entry of timestampFixes) {
      await tx`
        UPDATE drizzle.__drizzle_migrations
        SET created_at = ${entry.newCreatedAt}
        WHERE id = ${entry.id}
      `;
      console.log(`  Updated timestamp for ${entry.tag}: ${entry.oldCreatedAt} -> ${entry.newCreatedAt}`);
    }
  });

  console.log('\nAll fixes applied successfully.');
  await sql.end();
} catch (error) {
  console.error('\nAudit failed:', error.message);
  await sql.end();
  process.exit(1);
}
