#!/usr/bin/env node
/**
 * Type-check `tests/` against a per-file error baseline (BS#3509).
 *
 * jest runs ts-jest with `isolatedModules`, so it never type-checks tests, and
 * the root `typecheck` skips `tests/**`. Interface drift in a typed test helper
 * (BS#3502 vs BS#3500: `recordCounter` left in `createSpyReporter`) therefore
 * merged green. This runs `tsc -p tests/tsconfig.json` and fails when any file
 * has more errors than `tests/typecheck-baseline.json` records, or has errors
 * and is absent from it. The baseline holds the errors that predate the check;
 * it only goes down. Fix errors, then run with `--update` to rewrite it.
 *
 * Flags: `--input <file>` reads tsc output from a file instead of running tsc;
 * `--baseline <file>` overrides the baseline path; `--update` rewrites it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const baselinePath = flag('--baseline') ?? join(root, 'tests', 'typecheck-baseline.json');

let output;
try {
  const inputPath = flag('--input');
  if (inputPath) {
    output = readFileSync(inputPath, 'utf8');
  } else {
    const tsc = spawnSync('npx', ['tsc', '-p', 'tests/tsconfig.json', '--noEmit'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (tsc.error) {
      throw tsc.error;
    }
    output = tsc.stdout + tsc.stderr;
  }
} catch (e) {
  console.error(`check-tests-typecheck: could not obtain tsc output: ${e.message}`);
  process.exit(2);
}

const counts = {};
for (const m of output.matchAll(/^(\S+?)\(\d+,\d+\): error TS\d+:/gm)) {
  counts[m[1]] = (counts[m[1]] ?? 0) + 1;
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const total = Object.values(sorted).reduce((a, b) => a + b, 0);

if (args.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Baseline rewritten: ${total} errors in ${Object.keys(sorted).length} files.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const regressions = Object.entries(sorted).filter(([file, n]) => n > (baseline[file] ?? 0));
if (regressions.length > 0) {
  console.error('tests/ type errors above the baseline (fix them; do not raise the baseline):');
  for (const [file, n] of regressions) {
    console.error(`  ${file}: ${n} errors, baseline ${baseline[file] ?? 0}`);
  }
  process.exit(1);
}
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(`tests/ type errors: ${total} (baseline ${baselineTotal}).`);
if (total < baselineTotal) {
  console.log('Fewer than the baseline: run `npm run typecheck:tests -- --update` to ratchet it down.');
}
