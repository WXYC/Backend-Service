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
 * The run must be clean before anything is compared or written: tsc's exit
 * status is honored, a diagnostic with no file location (TS5083, say) is a hard
 * failure, and a non-zero exit with no parseable diagnostic (an OOM, a crash)
 * is a hard failure. `--update` refuses to write after an unclean run, so it
 * can never record an empty baseline. A file whose count drops below its
 * baseline also fails, so improvements are locked in by `--update` in the same PR.
 *
 * Flags: `--input <file>` reads tsc output from a file instead of running tsc
 * (with `--exit-code <n>` standing in for tsc's exit status, default 0);
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
let exitCode = 0;
try {
  const inputPath = flag('--input');
  if (inputPath) {
    output = readFileSync(inputPath, 'utf8');
    exitCode = Number(flag('--exit-code') ?? 0);
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
    // A signal-killed tsc (OOM killer) has a null status.
    exitCode = tsc.status ?? 1;
  }
} catch (e) {
  console.error(`check-tests-typecheck: could not obtain tsc output: ${e.message}`);
  process.exit(2);
}

// Anchor on the `(line,col): error TS` tail so paths that contain spaces parse.
const located = /^(.+?)\(\d+,\d+\): error TS\d+:/;
const counts = {};
const unattributed = [];
for (const line of output.split(/\r?\n/)) {
  const m = located.exec(line);
  if (m) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  } else if (/\berror TS\d+:/.test(line)) {
    unattributed.push(line);
  }
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const total = Object.values(sorted).reduce((a, b) => a + b, 0);

const problems = [];
if (unattributed.length > 0) {
  problems.push(`tsc reported ${unattributed.length} error(s) with no file location:`);
  problems.push(...unattributed.slice(0, 10).map((l) => `  ${l}`));
}
if (exitCode !== 0 && total === 0) {
  problems.push(`tsc exited with status ${exitCode} but produced no parseable diagnostics (crash or out of memory?).`);
}
if (problems.length > 0) {
  console.error('check-tests-typecheck: the tsc run was not clean, so no verdict and no baseline write:');
  for (const p of problems) {
    console.error(p);
  }
  process.exit(2);
}

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
const stale = Object.entries(baseline).filter(([file, n]) => (sorted[file] ?? 0) < n);
if (stale.length > 0) {
  console.error(
    'tests/ type errors are below the baseline, so it is stale. Run `npm run typecheck:tests -- --update` and commit it in this PR to lock the improvement in:'
  );
  for (const [file, n] of stale) {
    console.error(`  ${file}: ${sorted[file] ?? 0} errors, baseline ${n}`);
  }
  process.exit(1);
}
console.log(`tests/ type errors: ${total} (baseline matches).`);
