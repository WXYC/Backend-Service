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
 * `--update` only ever lowers counts: if any file's count rose, or a new file
 * has errors, it refuses (exit 1, writes nothing). A deliberate raise needs
 * `--update --allow-increase`, which a reviewer must look at.
 *
 * The run must be clean before anything is compared or written: tsc's exit
 * status is honored (only tsc's normal codes 0, 1 and 2 count as a run; any
 * other code is a hard failure even with diagnostics), a diagnostic with no file location (TS5083, say) is a hard
 * failure, and a non-zero exit with no parseable diagnostic (an OOM, a crash)
 * is a hard failure. `--update` refuses to write after an unclean run, so it
 * can never record an empty baseline. A file whose count drops below its
 * baseline also fails, so improvements are locked in by `--update` in the same PR.
 *
 * Flags: `--input <file>` reads tsc output from a file instead of running tsc
 * (with `--exit-code <n>` standing in for tsc's exit status, default 0);
 * `--baseline <file>` overrides the baseline path; `--update` rewrites it
 * (lower counts only unless `--allow-increase` is also given).
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
if (![0, 1, 2].includes(exitCode)) {
  problems.push(
    `tsc exited with status ${exitCode}, which is not a normal tsc exit code (0, 1 or 2): crash, out of memory or kill.`
  );
} else if (exitCode !== 0 && total === 0) {
  problems.push(`tsc exited with status ${exitCode} but produced no parseable diagnostics (crash or out of memory?).`);
}
if (problems.length > 0) {
  console.error('check-tests-typecheck: the tsc run was not clean, so no verdict and no baseline write:');
  for (const p of problems) {
    console.error(p);
  }
  process.exit(2);
}

const readBaseline = () => JSON.parse(readFileSync(baselinePath, 'utf8'));

if (args.includes('--update')) {
  if (!args.includes('--allow-increase')) {
    let current = {};
    try {
      current = readBaseline();
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`check-tests-typecheck: could not read the baseline: ${e.message}`);
        process.exit(2);
      }
    }
    const raised = Object.entries(sorted).filter(([file, n]) => n > (current[file] ?? 0));
    if (raised.length > 0) {
      console.error(
        'check-tests-typecheck: --update only lowers counts, and these files rose or are new. Nothing was written.'
      );
      console.error(
        'Fix the errors, or (if the raise is deliberate and a reviewer will look at it) pass --allow-increase.'
      );
      console.error(
        'If this looks wrong, run `npm run lint:prebuild` first: missing shared dists produce thousands of spurious errors.'
      );
      for (const [file, n] of raised) {
        console.error(`  ${file}: ${n} errors, baseline ${current[file] ?? 0}`);
      }
      process.exit(1);
    }
  }
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Baseline rewritten: ${total} errors in ${Object.keys(sorted).length} files.`);
  process.exit(0);
}

const baseline = readBaseline();
const regressions = Object.entries(sorted).filter(([file, n]) => n > (baseline[file] ?? 0));
if (regressions.length > 0) {
  console.error(
    'type errors in files covered by tests/tsconfig.json above the baseline (fix them; do not raise the baseline):'
  );
  for (const [file, n] of regressions) {
    console.error(`  ${file}: ${n} errors, baseline ${baseline[file] ?? 0}`);
  }
  process.exit(1);
}
const stale = Object.entries(baseline).filter(([file, n]) => (sorted[file] ?? 0) < n);
if (stale.length > 0) {
  console.error(
    'type errors in files covered by tests/tsconfig.json are below the baseline, so it is stale. Run `npm run lint:prebuild` first (the shared dists must exist), then `npm run typecheck:tests -- --update`, and commit the result in this PR to lock the improvement in:'
  );
  for (const [file, n] of stale) {
    console.error(`  ${file}: ${sorted[file] ?? 0} errors, baseline ${n}`);
  }
  process.exit(1);
}
console.log(`type errors in files covered by tests/tsconfig.json: ${total} (baseline matches).`);
