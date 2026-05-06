#!/usr/bin/env node

/**
 * Freezes the SHA-256 hash of every migration .sql file into
 * shared/database/src/migrations/meta/applied-hashes.json. Run after
 * `npm run drizzle:generate` adds a new migration, and commit the
 * updated JSON alongside the new .sql / journal / snapshot.
 *
 * The frozen file is the contract that `scripts/validate-migrations.mjs`
 * Check 11 enforces: any subsequent edit to a recorded migration's .sql
 * file produces a hash mismatch and fails CI before the deploy can wedge
 * (see WXYC/Backend-Service#705 follow-up).
 *
 * The hashes recorded here mirror what Drizzle applies to prod's
 * `drizzle.__drizzle_migrations.hash` column, so the PR-time check
 * (this file) and the deploy-time verifier (`dev_env/init-db.mjs`) agree
 * on what counts as drift. Editing applied-hashes.json is therefore as
 * load-bearing as editing _journal.json — only run this script via
 * `npm run drizzle:freeze-hashes` (which composes with `drizzle:generate`).
 */

import crypto from 'crypto';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const migrationsDir = 'shared/database/src/migrations';
const journalPath = join(migrationsDir, 'meta', '_journal.json');
const hashesPath = join(migrationsDir, 'meta', 'applied-hashes.json');

const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const tagsInJournal = new Set(journal.entries.map((e) => e.tag));

const sqlFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const hashes = {};
for (const file of sqlFiles) {
  const tag = file.replace(/\.sql$/, '');
  if (!tagsInJournal.has(tag)) {
    console.error(`ERROR: ${file} has no journal entry. Run \`npm run drizzle:generate\` first.`);
    process.exit(1);
  }
  const content = readFileSync(join(migrationsDir, file), 'utf8');
  hashes[tag] = crypto.createHash('sha256').update(content).digest('hex');
}

const sortedTags = Object.keys(hashes).sort();
const ordered = {};
for (const tag of sortedTags) ordered[tag] = hashes[tag];

writeFileSync(hashesPath, JSON.stringify(ordered, null, 2) + '\n');
console.log(`Wrote ${sortedTags.length} hash(es) to ${hashesPath}.`);
