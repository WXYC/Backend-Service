#!/usr/bin/env node
/**
 * Enforces the `flowsheet.legacy_entry_id` three-use invariant from BS#908 / Epic H#882.
 *
 * `legacy_entry_id` is overloaded across three orthogonal use cases that have
 * different correctness requirements:
 *
 *   1. **Webhook upsert target** (`apps/backend/routes/internal.route.ts`).
 *      `ON CONFLICT (legacy_entry_id) DO UPDATE`. Needs an actual tubafrenzy
 *      ID to dedup against. Reads via `flowsheet.legacy_entry_id` column.
 *
 *   2. **Mirror loop-guard** — RETIRED by BS#2403, which removed the outbound
 *      tubafrenzy mirror after Milestone 1 (WXYC/wiki#93) took the flowsheet
 *      surface to 410. It read the column as a boolean ("is this row from
 *      tubafrenzy? then don't mirror it back") and wrote the just-allocated
 *      tubafrenzy ID after a successful `mirrorCreateEntry`. Numbering is kept
 *      stable so the rationales below, and the three-use comment in
 *      `shared/database/src/schema.ts`, still read straight.
 *
 *   3. **ETL incremental sync key** (`jobs/flowsheet-etl/job.ts`).
 *      Same `ON CONFLICT (legacy_entry_id) DO UPDATE` shape as use #1.
 *
 * The remaining uses are fine today, but fragile: a future change that, say,
 * populates `legacy_entry_id` to a placeholder for non-tubafrenzy rows would
 * silently corrupt the `ON CONFLICT (legacy_entry_id)` dedup that uses #1, #3
 * and #4 all key on — colliding unrelated rows onto one upsert target. (Before
 * BS#2403 the sharper failure was use #2's loop-guard: such a row looked
 * tubafrenzy-born and was never mirrored.) This check pins the set of files
 * allowed to write the column; adding a new write site requires registering it
 * here with a documented rationale naming which use it belongs to.
 *
 * Wired into CI as the "legacy_entry_id writes" job in `.github/workflows/test.yml`.
 *
 * The check is intentionally coarse: it greps for the literal substring
 * `legacy_entry_id:` (object-literal key shape) anywhere in source, then
 * compares the producing file against this allowlist. Reads of `legacy_entry_id`
 * (e.g., `flowsheet.legacy_entry_id` column-reference selection) appear in this
 * key shape too in service code, so they're allowlisted explicitly with a
 * "READS only" rationale. A future PR adding a new file that touches the
 * column — read or write — must update this allowlist with a rationale.
 *
 * Exit codes:
 *   0 — allowlist matches reality. Every allowlisted file contains the pattern;
 *       no non-allowlisted file does.
 *   1 — a non-allowlisted file contains the pattern (new write site without
 *       a registered rationale).
 *   2 — an allowlisted file no longer contains the pattern (stale allowlist).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { isInvokedDirectly } from './lib/main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Allowlist: every file that may contain `legacy_entry_id:` in source.
// Each entry includes the use-case rationale (1, 2, 3, or "READS only").
// Adding a new entry requires updating the use-case comment in
// `shared/database/src/schema.ts` so future readers can find the invariant
// from any write site.
export const ALLOWLIST = new Map([
  [
    'apps/backend/routes/internal.route.ts',
    'use #1: tubafrenzy webhook upsert. INSERT values + ON CONFLICT target on `flowsheet.legacy_entry_id`.',
  ],
  [
    'jobs/flowsheet-etl/job.ts',
    'use #3: ETL incremental sync. INSERT values + ON CONFLICT target on `flowsheet.legacy_entry_id`.',
  ],
  [
    'jobs/flowsheet-etl/transform.ts',
    'use #3 (DTO): produces the row shape consumed by jobs/flowsheet-etl/job.ts insert.',
  ],
  [
    'jobs/flowsheet-april-gap-import/build-row.ts',
    'use #4 (BS#2119): insert-only backfill of the closed BS#351 residue. Pure row builder — produces the `GapImportRow` shape (type declaration + object literal) that orchestrate.ts inserts with `ON CONFLICT (legacy_entry_id) DO NOTHING`, never `DO UPDATE`. A real tubafrenzy-assigned id on every row (the discovery pass only ever selects ids confirmed present upstream and absent in Backend), so the ON CONFLICT dedup uses #1/#3 key on stays sound (and the retired use-#2 loop-guard was unaffected too).',
  ],
  [
    'jobs/flowsheet-april-gap-import/orchestrate.ts',
    "use #4 sibling (BS#2119): READS only here — a `db.execute` result-row type annotation (`Array<{ legacy_entry_id: number }>`) for the Backend-side existing-id check. The actual INSERT (`.onConflictDoNothing({ target: flowsheet.legacy_entry_id })` / `.returning({ legacyEntryId: flowsheet.legacy_entry_id })`) does not match this script's literal `legacy_entry_id:` pattern, since drizzle's column reference is aliased.",
  ],
  [
    'jobs/flowsheet-show-split/job.ts',
    "use #2/#3 sibling: `ensureLiveShowStartIsNewestMarker` deletes a `show_start` row and re-inserts it to obtain a higher serial id (the iOS banner reads `showMarkers.max(by: id)`), carrying the row's EXISTING legacy_entry_id across the re-mint so the ETL upsert key survives (and, before BS#2403 retired it, the mirror loop-guard too). Never mints or placeholders a value — the id written is one tubafrenzy already assigned to that same row. Written explicitly rather than via the object spread precisely so this check can see the write site.",
  ],
  ['shared/database/src/schema.ts', 'column declaration.'],
  ['apps/backend/services/flowsheet.service.ts', 'READS only: selection + result mapping. No writes.'],
]);

const PATTERN = /\blegacy_entry_id:/;

const SOURCE_ROOTS = ['apps', 'jobs', 'shared/database/src'];
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'tests',
  '__tests__',
  'migrations',
]);
const SKIP_FILE_SUFFIXES = ['.d.ts', '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.json', '.sql'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'];

function listSourceFiles(rootRelativePath) {
  const absRoot = join(REPO_ROOT, rootRelativePath);
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
    } else if (entry.isFile()) {
      const name = entry.name;
      if (SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s))) continue;
      if (!SOURCE_EXTENSIONS.some((s) => name.endsWith(s))) continue;
      out.push(join(dir, entry.name));
    }
  }
}

function fileMentionsPattern(absPath) {
  let src;
  try {
    src = readFileSync(absPath, 'utf-8');
  } catch {
    return false;
  }
  return PATTERN.test(src);
}

function main() {
  const failures = [];
  const staleAllowlistEntries = [];
  const matched = [];

  for (const root of SOURCE_ROOTS) {
    for (const abs of listSourceFiles(root)) {
      const rel = relative(REPO_ROOT, abs);
      if (!fileMentionsPattern(abs)) continue;
      matched.push(rel);
      if (!ALLOWLIST.has(rel)) {
        failures.push(rel);
      }
    }
  }

  for (const [rel] of ALLOWLIST) {
    const abs = join(REPO_ROOT, rel);
    if (!fileMentionsPattern(abs)) {
      staleAllowlistEntries.push(rel);
    }
  }

  if (failures.length > 0) {
    console.error('FAIL: file(s) reference `legacy_entry_id:` but are not in the allowlist.');
    console.error('      legacy_entry_id is overloaded across three use cases; any new write site must');
    console.error('      register its rationale in scripts/check-legacy-entry-id-writes.mjs ALLOWLIST.');
    console.error('      See BS#908 / Epic H#882 for the invariant.');
    for (const f of failures) console.error(`      - ${f}`);
    process.exit(1);
  }

  if (staleAllowlistEntries.length > 0) {
    console.error('FAIL: allowlist entries no longer contain `legacy_entry_id:` (stale).');
    console.error('      Remove the entry from ALLOWLIST or restore the reference.');
    for (const f of staleAllowlistEntries) console.error(`      - ${f}`);
    process.exit(2);
  }

  console.log(`PASS: ${matched.length} source file(s) reference legacy_entry_id; all in the allowlist.`);
}

if (isInvokedDirectly(import.meta.url)) {
  main();
}
