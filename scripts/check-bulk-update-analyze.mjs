#!/usr/bin/env node
/**
 * Static check: every `.sql` file in this repo that issues an `UPDATE`
 * must either also `ANALYZE` the touched tables or carry an explicit
 * `-- @no-analyze-needed: <reason>` suppression comment (BS#934).
 *
 * Why: when a bulk UPDATE rewrites columns that GIN/btree indexes cover,
 * the planner's stats go stale until the next autovacuum/ANALYZE. Until
 * then, queries that *should* use those indexes can fall off the trigram
 * / partial-index path and start scanning the full table. The 2026-05-15
 * dj-site autocomplete regression was exactly this shape: the mojibake-
 * recovery script (`scripts/audit/bs_replacement_char_recovery.sql`) ran
 * 34 UPDATEs across `flowsheet`/`library`/`rotation` without an ANALYZE,
 * and `/flowsheet/suggest/tracks` started timing out at the Express 5s
 * cutoff. See the bulk-UPDATE playbook at `docs/bulk-update-playbook.md`
 * for the full operational pattern.
 *
 * Scope (where SQL UPDATE statements legitimately live):
 *   - `shared/database/src/migrations/` — Drizzle migrations. Hash-frozen
 *     after apply, so already-applied files can't gain a comment without
 *     breaking Check 11. The `HISTORICAL_NO_ANALYZE_NEEDED_TAGS` allowlist
 *     is the per-tag escape hatch for them; new migrations must annotate
 *     in-file.
 *   - `scripts/` — operator-run SQL (recovery, audit, ad-hoc). Not hash-
 *     frozen; should always carry ANALYZE or the suppression.
 *   - `jobs/` — backfill jobs that ship as Docker containers. The `.sql`
 *     ones are typically templates; same rule.
 *
 * Detection: line-level. Strips `--` line comments before scanning, then
 * extracts table refs from `UPDATE [ONLY] [schema.]table` and
 * `ANALYZE [schema.]table[, ...]` / bare `ANALYZE;` (covers all tables).
 * Bare-table UPDATEs match against bare-table ANALYZEs and vice versa
 * (PostgreSQL resolves both via search_path at execution time, so the
 * check follows suit). Block comments are not used in this codebase.
 *
 * Suppression: `-- @no-analyze-needed: <reason>` anywhere in the file.
 * Reasons that pass the spirit of the check (not enforced by the script):
 *   - Single-row UPDATE on a small config / lookup table.
 *   - UPDATE on a table with no covering indexes.
 *   - ANALYZE handled out-of-band by a separate operator step.
 *
 * Default behavior is warn-only (exit 0, prints findings to stderr) so
 * the check doesn't break CI on legitimate edge cases the author didn't
 * anticipate. Pass `--strict` to exit 1 on any finding — used by the
 * test suite to exercise the failure path.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Cwd-relative root (so tests can run the script against a synthetic tree).
const REPO_ROOT = process.cwd();
// Fall back to the script's own parent when cwd doesn't look like a repo root.
const SCRIPT_REPO_ROOT = resolve(__dirname, '..');

const SOURCE_ROOTS = ['shared/database/src/migrations', 'scripts', 'jobs'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '__pycache__']);

// Per-tag allowlist for ALREADY-APPLIED migrations. Their .sql bytes are
// hash-frozen in `meta/applied-hashes.json` (validate-migrations Check 11),
// so we cannot add a `-- @no-analyze-needed:` comment without breaking the
// hash. Each entry MUST include a one-line rationale and the count of
// UPDATEd rows so future readers know the cost shape. New migration files
// must annotate in-line — they have no entry here.
//
// Adding to this allowlist requires confirming the migration is already
// applied and that the UPDATE was small enough that ANALYZE wouldn't have
// changed planner behavior, OR documenting the operational ANALYZE that
// was run alongside.
export const HISTORICAL_NO_ANALYZE_NEEDED_TAGS = new Map([
  [
    '0024_flowsheet_entry_type',
    'Backfill UPDATEs the new entry_type column on a then-much-smaller flowsheet; pre-trigram indexes.',
  ],
  [
    '0043_add-has-completed-onboarding',
    'Backfills the new column on auth_user (tiny table, no covering indexes that matter).',
  ],
  [
    '0060_library-artist-name-cascade-trigger',
    'Trigger creation + one-time backfill of library.artist_name; pre-mojibake era.',
  ],
  [
    '0064_propagate-v012-mojibake',
    'V012 mojibake fix; touched columns later got the GIN trigram indexes, so the planner-stats lesson postdates this migration.',
  ],
  ['0066_replay-v012-mojibake', 'Replay of V012 after the journal-skip cursor bug; same data shape as 0064.'],
]);

function isStrictMode() {
  return process.argv.slice(2).includes('--strict');
}

function listSqlFiles(rootRelative, repoRoot) {
  const absRoot = join(repoRoot, rootRelative);
  let stat;
  try {
    stat = statSync(absRoot);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const out = [];
  walk(absRoot, out);
  return out;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      out.push(join(dir, entry.name));
    }
  }
}

function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

// Extract `(schema.table | table)` pairs from each data-modifying UPDATE.
// A data-modifying UPDATE is identified by the `... SET` clause — DML only.
// This intentionally excludes embedded forms that share the keyword:
//   - `ON UPDATE no action` (FK referential actions; no SET follows)
//   - `AFTER INSERT OR UPDATE OR DELETE` (trigger event lists; no SET)
//
// Catches CTE-prefixed UPDATEs (`WITH ... UPDATE table SET ...`) and
// aliased UPDATEs (`UPDATE table t SET ...`) by allowing an optional
// alias word between the table and SET.
//
// Limits: dollar-quoted bodies (`DO $$ ... UPDATE ... SET ... $$`) are
// scanned the same as top-level UPDATEs. That over-reports for migrations
// that wrap DML inside guards. Suppression annotation is the escape hatch
// when that occurs.
function extractUpdateTables(sql) {
  const stripped = stripLineComments(sql);
  const tables = new Set();
  // `UPDATE [ONLY] [schema.]table [[AS] alias] SET`
  const re = /\bUPDATE\s+(?:ONLY\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?(?:\s+(?:AS\s+)?\w+)?\s+SET\b/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const schema = m[1];
    const table = m[2];
    tables.add(schema ? `${schema}.${table}` : table);
  }
  return tables;
}

// Returns either Set<string> of analyzed table names, or the literal '*' if
// a bare `ANALYZE;` (no table list) is present — that re-stats everything.
function extractAnalyzeCoverage(sql) {
  const stripped = stripLineComments(sql);
  const tables = new Set();
  let bareAnalyze = false;

  // Match each `ANALYZE` statement up to the first `;` and parse its table list.
  // Examples covered: `ANALYZE;`, `ANALYZE flowsheet;`, `ANALYZE wxyc_schema.flowsheet;`,
  // `ANALYZE flowsheet, rotation;`, `ANALYZE VERBOSE flowsheet;`.
  const stmtRe = /\bANALYZE\b(\s+VERBOSE)?([^;]*);/gi;
  let m;
  while ((m = stmtRe.exec(stripped)) !== null) {
    const body = (m[2] ?? '').trim();
    if (body === '') {
      bareAnalyze = true;
      continue;
    }
    // Split on commas (and parenthesized column lists are out of scope here —
    // ANALYZE table(col1, col2) is allowed by PG but rare in practice).
    for (const ref of body.split(',')) {
      const tableRe = /(?:"?(\w+)"?\.)?"?(\w+)"?/;
      const tm = ref.trim().match(tableRe);
      if (!tm) continue;
      const schema = tm[1];
      const table = tm[2];
      if (!table) continue;
      tables.add(schema ? `${schema}.${table}` : table);
    }
  }

  return { tables, bareAnalyze };
}

// True iff every UPDATEd table has a matching ANALYZE entry. A bare ANALYZE
// is a wildcard. Bare-table UPDATEs match either form; schema-qualified
// UPDATEs match either form too (PostgreSQL search_path makes them
// equivalent at execution time).
function findMissingAnalyzeTables(updateTables, analyzeCoverage) {
  if (analyzeCoverage.bareAnalyze) return [];
  const missing = [];
  for (const updated of updateTables) {
    if (analyzeCoverage.tables.has(updated)) continue;
    // Cross-match by bare table name (drop schema prefix from both sides).
    const updatedBare = updated.includes('.') ? updated.split('.')[1] : updated;
    let covered = false;
    for (const analyzed of analyzeCoverage.tables) {
      const analyzedBare = analyzed.includes('.') ? analyzed.split('.')[1] : analyzed;
      if (analyzedBare === updatedBare) {
        covered = true;
        break;
      }
    }
    if (!covered) missing.push(updated);
  }
  return missing;
}

function hasSuppression(sql) {
  return /--\s*@no-analyze-needed\s*:/i.test(sql);
}

function migrationTagFromPath(rel) {
  // Match `shared/database/src/migrations/<tag>.sql` exactly (not files in
  // subdirs or non-migration paths that happen to share a basename).
  const m = rel.match(/^shared\/database\/src\/migrations\/([^/]+)\.sql$/);
  return m ? m[1] : null;
}

function main(repoRoot) {
  const findings = [];

  for (const root of SOURCE_ROOTS) {
    for (const abs of listSqlFiles(root, repoRoot)) {
      const rel = relative(repoRoot, abs).split('\\').join('/');
      const sql = readFileSync(abs, 'utf-8');

      const tag = migrationTagFromPath(rel);
      if (tag && HISTORICAL_NO_ANALYZE_NEEDED_TAGS.has(tag)) continue;
      if (hasSuppression(sql)) continue;

      const updateTables = extractUpdateTables(sql);
      if (updateTables.size === 0) continue;

      const coverage = extractAnalyzeCoverage(sql);
      const missing = findMissingAnalyzeTables(updateTables, coverage);
      if (missing.length > 0) {
        findings.push({ file: rel, missing });
      }
    }
  }

  if (findings.length === 0) {
    console.log(
      'PASS: every UPDATE-bearing .sql file under shared/database/src/migrations, scripts, jobs is paired with ANALYZE or suppression.'
    );
    return 0;
  }

  const strict = isStrictMode();
  const level = strict ? 'FAIL' : 'WARN';
  console.error(
    `${level}: ${findings.length} file(s) UPDATE tables without a matching ANALYZE or @no-analyze-needed suppression.`
  );
  console.error(
    '       See docs/bulk-update-playbook.md and docs/migrations.md (post-bulk-update-analyze rule). BS#934 for the original incident.'
  );
  for (const f of findings) {
    console.error(`       - ${f.file}: missing ANALYZE for ${[...f.missing].join(', ')}`);
  }
  return strict ? 1 : 0;
}

import { realpathSync } from 'node:fs';
const invokedDirectly = (() => {
  try {
    return realpathSync(resolve(process.argv[1] ?? '')) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // Prefer the cwd as repo root (so tests can run against a temp tree); fall
  // back to the script's parent dir if cwd doesn't have the expected layout.
  const probeRoot = (root) =>
    SOURCE_ROOTS.some((r) => {
      try {
        return statSync(join(root, r)).isDirectory();
      } catch {
        return false;
      }
    });
  const root = probeRoot(REPO_ROOT) ? REPO_ROOT : SCRIPT_REPO_ROOT;
  process.exit(main(root));
}
