#!/usr/bin/env node

/**
 * Validates migration journal integrity. Run as a CI check to prevent
 * out-of-order timestamps from being merged — Drizzle silently skips
 * migrations whose "when" timestamp is earlier than the most recently
 * applied migration's created_at.
 *
 * Checks:
 * 1. All "when" timestamps are strictly monotonically increasing
 * 2. Every journal entry has a corresponding .sql file
 * 3. No orphaned .sql files exist without a journal entry
 *
 * See: https://github.com/WXYC/Backend-Service/issues/400
 */

import { readFileSync, readdirSync } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

const journalPath = 'shared/database/src/migrations/meta/_journal.json';
const migrationsDir = 'shared/database/src/migrations';

const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
let errors = 0;

// Check 1: Monotonically increasing timestamps
let prevWhen = 0;
let prevTag = '';
for (const entry of journal.entries) {
  if (entry.when <= prevWhen) {
    console.error(
      `ERROR: Out-of-order timestamp at idx ${entry.idx} (${entry.tag}):\n` +
        `  when=${entry.when} must be > previous when=${prevWhen} (${prevTag})\n`
    );
    errors++;
  }
  prevWhen = entry.when;
  prevTag = entry.tag;
}

// Check 2: Every journal entry has a .sql file
for (const entry of journal.entries) {
  const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
  if (!existsSync(sqlPath)) {
    console.error(`ERROR: Missing SQL file for journal entry idx ${entry.idx}: ${sqlPath}`);
    errors++;
  }
}

// Check 3: No orphaned .sql files
const journalTags = new Set(journal.entries.map((e) => e.tag));
const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
for (const file of sqlFiles) {
  const tag = file.replace('.sql', '');
  if (!journalTags.has(tag)) {
    console.error(`ERROR: Orphaned SQL file not in journal: ${file}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\nMigration validation failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log(`Migration journal validation passed (${journal.entries.length} entries).`);
}
