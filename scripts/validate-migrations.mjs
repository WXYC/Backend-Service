#!/usr/bin/env node

/**
 * Validates Drizzle migration metadata. Run as a CI check to prevent
 * journal corruption (out-of-order timestamps, conflict markers, broken
 * prevId chain, duplicate idxs) from being merged.
 *
 * Drizzle silently skips migrations whose "when" timestamp is earlier than
 * the most recently applied migration's created_at, and `drizzle-kit generate`
 * uses `lastEntry.idx + 1` for the next migration's idx -- so a duplicate idx
 * cascades into ambiguous bookkeeping.
 *
 * Checks:
 * 1. All "when" timestamps are strictly monotonically increasing
 * 2. Every journal entry has a corresponding .sql file
 * 3. No orphaned .sql files exist without a journal entry
 * 4. Every meta/*.json file parses (catches conflict markers)
 * 5. No duplicate idxs in journal (with HISTORICAL_DUPLICATE_IDXS allowlist)
 * 6. The latest snapshot's prevId chain is reachable back to the genesis
 *    snapshot (allowing breaks at known-dropped historical idxs)
 *
 * See: WXYC/Backend-Service#400 (timestamp ordering),
 *      WXYC/Backend-Service#505 (metadata repair),
 *      WXYC/wxyc-shared#82 (Phase 4 epic).
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const journalPath = 'shared/database/src/migrations/meta/_journal.json';
const migrationsDir = 'shared/database/src/migrations';
const metaDir = join(migrationsDir, 'meta');

// Idx values that drop targets left behind. Keeping the journal/snapshot
// state read-only means these break the prevId chain by design; the
// validator skips them rather than failing.
const DROPPED_IDXS = new Set([1, 5, 8]);

// Historical duplicate idxs that predate this validator. Tracked as an
// allowlist so future PRs can't introduce new ones. Each entry is a
// duplicate idx; both journal entries at that idx are accepted.
const HISTORICAL_DUPLICATE_IDXS = new Set([47]);

const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
let errors = 0;
let warnings = 0;

// Check 1: Monotonically increasing timestamps
{
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
{
  const journalTags = new Set(journal.entries.map((e) => e.tag));
  const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  for (const file of sqlFiles) {
    const tag = file.replace('.sql', '');
    if (!journalTags.has(tag)) {
      console.error(`ERROR: Orphaned SQL file not in journal: ${file}`);
      errors++;
    }
  }
}

// Check 4: Every meta/*.json file parses (catches merge-conflict markers)
const snapshotsById = new Map();
const metaFiles = readdirSync(metaDir).filter((f) => f.endsWith('.json') && f !== '_journal.json');
for (const file of metaFiles) {
  const path = join(metaDir, file);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`ERROR: Cannot read ${path}: ${e.message}`);
    errors++;
    continue;
  }
  if (raw.includes('<<<<<<<') || raw.includes('>>>>>>>')) {
    console.error(`ERROR: Conflict markers in ${path}`);
    errors++;
    continue;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.id) {
      snapshotsById.set(parsed.id, { file, prevId: parsed.prevId });
    }
  } catch (e) {
    console.error(`ERROR: Invalid JSON in ${path}: ${e.message}`);
    errors++;
  }
}

// Check 5: No new duplicate idxs (allowlist historical ones)
{
  const idxCounts = new Map();
  for (const entry of journal.entries) {
    idxCounts.set(entry.idx, (idxCounts.get(entry.idx) || 0) + 1);
  }
  for (const [idx, count] of idxCounts) {
    if (count > 1 && !HISTORICAL_DUPLICATE_IDXS.has(idx)) {
      const dups = journal.entries.filter((e) => e.idx === idx).map((e) => e.tag);
      console.error(`ERROR: Duplicate idx ${idx} in journal: ${dups.join(', ')}`);
      errors++;
    } else if (count > 1) {
      const dups = journal.entries.filter((e) => e.idx === idx).map((e) => e.tag);
      console.warn(`WARN:  Historical duplicate idx ${idx} (allowlisted): ${dups.join(', ')}`);
      warnings++;
    }
  }
}

// Check 6: prevId chain from latest snapshot back to genesis. Walk only the
// latest entry's chain (not every snapshot file) so we don't fail on
// intentionally-dropped or missing intermediate snapshots.
//
// We pick the latest snapshot by alphabetical filename (Drizzle's own
// behaviour in `prepareOutFolder`) so the chain we walk matches what
// `drizzle-kit generate` will diff against on the next migration.
if (metaFiles.length > 0) {
  const latestFile = [...metaFiles].sort().pop();
  const latestRaw = readFileSync(join(metaDir, latestFile), 'utf8');
  let latest;
  try {
    latest = JSON.parse(latestRaw);
  } catch {
    latest = null;
  }
  if (latest) {
    const visited = new Set();
    let cursor = latest;
    let cursorFile = latestFile;
    while (cursor && cursor.prevId && cursor.prevId !== '00000000-0000-0000-0000-000000000000') {
      if (visited.has(cursor.id)) {
        console.error(`ERROR: Cycle detected in prevId chain at ${cursorFile} (id=${cursor.id})`);
        errors++;
        break;
      }
      visited.add(cursor.id);
      const next = snapshotsById.get(cursor.prevId);
      if (!next) {
        // Look up the matching journal entry to decide if this is a
        // known-dropped break or a real chain corruption.
        const cursorEntry = journal.entries.find(
          (e) =>
            `${e.idx.toString().padStart(4, '0')}_snapshot.json` === cursorFile ||
            `${e.tag.split('_')[0]}_snapshot.json` === cursorFile
        );
        const expectedPrevIdx = cursorEntry ? cursorEntry.idx - 1 : null;
        if (expectedPrevIdx !== null && DROPPED_IDXS.has(expectedPrevIdx)) {
          // Expected break -- skipped/dropped historical idx. Stop walking.
          break;
        }
        console.error(
          `ERROR: prevId ${cursor.prevId} from ${cursorFile} not found in any snapshot ` +
            `(missing intermediate snapshot or broken chain)`
        );
        errors++;
        break;
      }
      cursor = JSON.parse(readFileSync(join(metaDir, next.file), 'utf8'));
      cursorFile = next.file;
    }
  }
}

if (errors > 0) {
  console.error(`\nMigration validation failed with ${errors} error(s) and ${warnings} warning(s).`);
  process.exit(1);
} else {
  console.log(`Migration journal validation passed (${journal.entries.length} entries, ${warnings} warning(s)).`);
}
