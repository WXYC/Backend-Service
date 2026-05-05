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
 * 7. Every non-allowlisted journal entry has a corresponding snapshot file
 *    (catches the hand-edit-the-journal-without-running-generate pattern
 *    that accumulated 12+ missing snapshots between 0057 and 0067 — see
 *    WXYC/Backend-Service#590)
 * 8. WARNING: every constraint-adding migration (UNIQUE, CHECK, NOT NULL,
 *    FOREIGN KEY) carries a `DO $$ ... RAISE EXCEPTION ... END $$;`
 *    precondition guard above the DDL. Suppressible per-migration with a
 *    `-- @no-precondition-needed: <reason>` comment when the constraint
 *    is provably safe (e.g. UNIQUE on a freshly-added nullable column,
 *    NOT NULL paired with DEFAULT, fresh CREATE TABLE). This is a
 *    warning, not an error — guards aren't always needed and CI must
 *    not gate on the soft signal. See WXYC/Backend-Service#705.
 * 9. WARNING: RAISE EXCEPTION messages cite **explicit paths** under
 *    `jobs/`, `scripts/`, `apps/`, or `shared/` that exist in the repo.
 *    Migrations whose precondition guards point operators at a runbook
 *    on an unmerged feature branch leave the deploy with no recoverable
 *    next step. **Scope limitation:** free-form prose references (e.g.
 *    "Run rotation-dedupe job" without a `jobs/` prefix) are not
 *    detected — tightening the regex to catch prose would inflate
 *    false positives. The check is forward-looking; future migrations
 *    that explicitly write `jobs/foo` will be caught. Suppressible with
 *    `-- @no-runbook-needed: <reason>`. See WXYC/Backend-Service#727.
 *
 * See: WXYC/Backend-Service#400 (timestamp ordering),
 *      WXYC/Backend-Service#505 (metadata repair),
 *      WXYC/Backend-Service#590 (snapshot catch-up),
 *      WXYC/Backend-Service#705 (precondition guards),
 *      WXYC/Backend-Service#727 (RAISE message paths),
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

// Historical orphan SQL files: present in the migrations directory and
// applied to production but never journaled. The 0046 trigger file was
// deployed via a hotfix path that bypassed drizzle:generate; it has been
// idempotent in prod since deploy and re-running it would fail because
// the trigger functions don't use CREATE OR REPLACE. Listing it here
// acknowledges the orphan rather than fabricating a journal entry that
// drizzle would then attempt to re-apply.
const KNOWN_ORPHAN_TAGS = new Set(['0046_cdc_notify_triggers']);

// Historical idxs whose journal entry has no matching snapshot file. Two
// origin clusters:
//   - 36, 41, 47-54: predate this validator; #505 noted but never repaired
//   - 57-67: accumulated through 2026-04 by the hand-edit-SQL-and-journal
//            convention that bypassed `drizzle-kit generate`. PR #590
//            shipped a single 0068_snapshot.json reflecting current schema
//            and this allowlist tolerates the gap.
// New PRs that add a migration MUST emit its snapshot — Check 7 enforces
// this against any new idx outside the allowlist.
const HISTORICAL_MISSING_SNAPSHOT_IDXS = new Set([
  36, 41, 47, 48, 49, 50, 51, 52, 53, 54, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67,
]);

// Tags that predate the precondition-guard rule (issue #705). Already
// applied to prod; the rule was introduced 2026-05-01 and was retroactively
// applied to the five most recent constraint-adding migrations as exemplars
// (0034, 0048, 0059, 0067, 0071). Everything else in this set is grandfathered
// and Check 8 ignores it. New tags must NOT be added here — Check 8 fires on
// any future PR's migration that adds a constraint without a guard or a
// `-- @no-precondition-needed:` annotation.
const HISTORICAL_NO_GUARD_NEEDED_TAGS = new Set([
  '0000_rare_prima',
  '0004_thin_alice',
  '0010_polite_black_tarantula',
  '0012_chubby_bromley',
  '0014_zippy_secret_warriors',
  '0016_nervous_hydra',
  '0020_sticky_alex_power',
  '0021_user-table-migration',
  '0022_library_cross_reference',
  '0023_metadata_tables',
  '0024_anonymous_devices',
  '0024_flowsheet_entry_type',
  '0025_rate_limiting_tables',
  '0029_add_artists_alphabetical_name',
  '0030_labels_table',
  '0032_audit_f19_f20',
  '0033_crossreference_tables',
  '0037_etl-schema-sync',
  '0041_rotation_etl_support',
]);

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

// Check 3: No orphaned .sql files (other than the historical allowlist)
{
  const journalTags = new Set(journal.entries.map((e) => e.tag));
  const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  for (const file of sqlFiles) {
    const tag = file.replace('.sql', '');
    if (!journalTags.has(tag) && !KNOWN_ORPHAN_TAGS.has(tag)) {
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

// Check 7: every journal entry has a corresponding snapshot file (with
// the historical-missing allowlist). drizzle-kit's `generate` emits a
// snapshot alongside every new migration; hand-editing the journal
// without running generate skips the snapshot and the rot accumulates
// silently because Check 6 only walks the latest entry's chain. This
// check fires on the next contributor who hand-edits the journal.
{
  const snapshotIdxs = new Set();
  for (const file of metaFiles) {
    const m = file.match(/^(\d+)_snapshot\.json$/);
    if (m) snapshotIdxs.add(parseInt(m[1], 10));
  }
  for (const entry of journal.entries) {
    if (snapshotIdxs.has(entry.idx)) continue;
    if (HISTORICAL_MISSING_SNAPSHOT_IDXS.has(entry.idx)) {
      // Allowlisted gap; do not warn per-idx (would be 21 warnings).
      continue;
    }
    if (DROPPED_IDXS.has(entry.idx)) continue;
    console.error(
      `ERROR: Missing snapshot for journal entry idx ${entry.idx} (${entry.tag}): ` +
        `expected meta/${entry.idx.toString().padStart(4, '0')}_snapshot.json. ` +
        `Run \`npm run drizzle:generate\` so drizzle-kit emits the snapshot ` +
        `instead of hand-editing the journal.`
    );
    errors++;
  }
}

// Check 8: WARNING — constraint-adding DDL outside a CREATE TABLE body
// should be paired with a DO $$ ... RAISE EXCEPTION ... END $$;
// precondition guard earlier in the file. Suppressible via a
// `-- @no-precondition-needed: <reason>` comment anywhere in the file.
//
// This is a soft warning (never bumps `errors`) because the guard is a
// defense-in-depth signal, not a strict prerequisite — some constraints
// are provably safe (UNIQUE on a freshly-added nullable column, FK shape
// changes that re-target the same column, fresh materialized views with
// GROUP BY uniqueness). The annotation forces the author to reason about
// the case explicitly. See WXYC/Backend-Service#705.
//
// Detection scope (post-creation constraint-adding only — CREATE TABLE
// bodies are skipped because the constraints are evaluated against zero
// rows at apply time):
//   - CREATE UNIQUE INDEX (partial or full)
//   - ALTER TABLE ... ADD CONSTRAINT (UNIQUE / CHECK / FK / PK)
//   - ALTER TABLE ... ALTER COLUMN ... SET NOT NULL
//   - ALTER TABLE ... ADD COLUMN ... NOT NULL (without DEFAULT — DEFAULT
//     paired with NOT NULL is provably safe because every row gets the
//     default at add time)
{
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const tag = file.replace(/\.sql$/, '');
    if (HISTORICAL_NO_GUARD_NEEDED_TAGS.has(tag)) continue;
    const path = join(migrationsDir, file);
    const raw = readFileSync(path, 'utf8');

    // Strip line comments so `-- adds NOT NULL` doesn't false-trigger the
    // detection. Block comments aren't used in this codebase.
    const stripped = raw
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--');
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join('\n');

    // Strip CREATE TABLE bodies. A fresh table's constraints can't be
    // violated by data that doesn't exist yet. We consume from
    // `CREATE TABLE` through the matching closing `);` (greedy across
    // lines). drizzle-kit emits CREATE TABLE bodies on multiple lines
    // ending with `);` then either `\n` or a `--> statement-breakpoint`.
    const withoutCreateTable = stripped.replace(/\bCREATE\s+TABLE\b[\s\S]*?\)\s*;/gi, '');

    const constraintPatterns = [
      { name: 'CREATE UNIQUE INDEX', re: /\bCREATE\s+UNIQUE\s+INDEX\b/i },
      { name: 'ALTER TABLE ... ADD CONSTRAINT', re: /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+CONSTRAINT\b/i },
      {
        name: 'ALTER TABLE ... ALTER COLUMN ... SET NOT NULL',
        re: /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+COLUMN\b[\s\S]*?\bSET\s+NOT\s+NULL\b/i,
      },
      {
        // ADD COLUMN ... NOT NULL with no DEFAULT in the same statement.
        // We bound the lookahead to `;` to keep it within one statement.
        name: 'ALTER TABLE ... ADD COLUMN ... NOT NULL (no DEFAULT)',
        re: /\bALTER\s+TABLE\b[^;]*\bADD\s+COLUMN\b(?:(?!\bDEFAULT\b)[^;])*?\bNOT\s+NULL\b(?:(?!\bDEFAULT\b)[^;])*;/i,
      },
    ];

    const matches = constraintPatterns.filter((p) => p.re.test(withoutCreateTable));
    if (matches.length === 0) continue;

    // Suppression comment is matched against the raw file (including
    // comment lines) so authors can place it anywhere.
    if (/--\s*@no-precondition-needed\s*:/i.test(raw)) continue;

    // Guard: a DO $$ ... RAISE EXCEPTION ... END $$; block above the
    // first constraint-adding DDL match. We approximate "earlier in the
    // file" by requiring the guard to appear somewhere in `stripped`
    // before the earliest match index.
    const firstMatchIdx = Math.min(
      ...matches.map((p) => {
        const m = withoutCreateTable.match(p.re);
        return m ? withoutCreateTable.indexOf(m[0]) : Number.POSITIVE_INFINITY;
      })
    );
    const head = withoutCreateTable.slice(0, firstMatchIdx);
    const guardPresent = /\bDO\s+\$\$[\s\S]*?\bRAISE\s+EXCEPTION\b[\s\S]*?\bEND\s*\$\$/i.test(head);
    if (guardPresent) continue;

    console.warn(
      `WARN:  ${file} adds a constraint (${matches.map((m) => m.name).join(', ')}) ` +
        `but has no \`DO $$ ... RAISE EXCEPTION ... END $$;\` precondition guard. ` +
        `Add a guard above the DDL, or document why one isn't needed with ` +
        `a \`-- @no-precondition-needed: <reason>\` comment. ` +
        `See CLAUDE.md "Constraint-adding migrations should include precondition guards" ` +
        `and issue #705.`
    );
    warnings++;
  }
}

// Check 9: WARNING — RAISE EXCEPTION messages should cite paths reachable
// from main. Migrations whose precondition guards reference a runbook
// (e.g. "Run jobs/rotation-dedupe first") that points to an unmerged
// feature branch leave operators with a broken next-step on deploy
// failure (the prompting case: 0071 cites a job path that exists only on
// task/694-rotation-dedupe).
//
// Scope: only path-shaped tokens under `jobs/`, `scripts/`, `apps/`, or
// `shared/` are checked. Prose-style references ("rotation-dedupe job"
// with no `jobs/` prefix) are deliberately out of scope — tightening the
// regex to match prose would inflate false positives, and the explicit-
// path case is the higher-confidence signal anyway. Existence is the
// bar; this check does not validate that the path is runnable.
//
// Suppressible per-migration with `-- @no-runbook-needed: <reason>` when
// a path-shaped token isn't really a path (URLs, doc references).
{
  const RAISE_PATTERN = /RAISE\s+EXCEPTION\s+(['"])((?:[^'\\]|\\.)*?)\1/gi;
  const PATH_PATTERN = /\b(?:jobs|scripts|apps|shared)\/[A-Za-z0-9_./-]+/g;
  const SUPPRESS_PATTERN = /--\s*@no-runbook-needed\s*:/i;

  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const sqlPath = join(migrationsDir, file);
    const content = readFileSync(sqlPath, 'utf8');
    if (SUPPRESS_PATTERN.test(content)) continue;

    const seen = new Set();
    let match;
    while ((match = RAISE_PATTERN.exec(content)) !== null) {
      const messageText = match[2];
      const paths = messageText.match(PATH_PATTERN) ?? [];
      for (const candidate of paths) {
        // Strip trailing punctuation: 'See jobs/foo.' should resolve to
        // 'jobs/foo' rather than miss because of the period.
        const trimmed = candidate.replace(/[.,;:!?]+$/, '');
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        if (!existsSync(trimmed)) {
          console.warn(
            `WARN:  ${file} RAISE EXCEPTION cites '${trimmed}' which doesn't exist on main. ` +
              `Either merge the runbook before this migration ships, rephrase the message, ` +
              `or suppress with '-- @no-runbook-needed: <reason>'. ` +
              `See WXYC/Backend-Service#727.`
          );
          warnings++;
        }
      }
    }
  }
}

if (errors > 0) {
  console.error(`\nMigration validation failed with ${errors} error(s) and ${warnings} warning(s).`);
  process.exit(1);
} else {
  console.log(`Migration journal validation passed (${journal.entries.length} entries, ${warnings} warning(s)).`);
}
