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
 *   2. **Mirror loop-guard** (`apps/backend/middleware/legacy/flowsheet.mirror.ts`).
 *      `if (entry.legacy_entry_id != null) return;` — "this entry came from
 *      tubafrenzy via ETL, don't mirror back." Treats the column as a boolean
 *      ("is this row from tubafrenzy?"). Writes happen *after* a successful
 *      `mirrorCreateEntry` (the inverse direction) to record the just-allocated
 *      tubafrenzy ID for ETL dedup.
 *
 *   3. **ETL incremental sync key** (`jobs/flowsheet-etl/job.ts`).
 *      Same `ON CONFLICT (legacy_entry_id) DO UPDATE` shape as use #1.
 *
 * The three uses are fine today, but fragile: a future change that, say,
 * populates `legacy_entry_id` to a placeholder for non-tubafrenzy rows would
 * silently break use #2 (the mirror loop-guard), sending those rows back to
 * tubafrenzy and creating an infinite mirror loop. This check pins the set of
 * files allowed to write the column; adding a new write site requires
 * registering it here with a documented rationale that names which of the
 * three uses (or a new fourth) it belongs to.
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
// Adding a new entry requires updating the three-use comment in
// `shared/database/src/schema.ts` and `apps/backend/middleware/legacy/flowsheet.mirror.ts`
// so future readers can find the invariant from any write site.
export const ALLOWLIST = new Map([
  [
    'apps/backend/middleware/legacy/flowsheet.mirror.ts',
    'use #2 (mirror loop-guard, READS) + writes that record the just-allocated tubafrenzy ID after mirrorCreateEntry returns.',
  ],
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
