#!/usr/bin/env node
/**
 * Lint only what a push changes (BS#3556), so the pre-push hook does not hold a
 * whole-repo typed ESLint program (about 5 GB) per concurrent push.
 *
 * Diffs merge-base(HEAD, origin/main)..HEAD (ACMR) and picks a mode:
 *  - full: a config, tsconfig, package manifest or `.d.ts` changed (or there is
 *    no origin/main to diff against), so any file's result may change. Lints
 *    every tracked source file, one eslint process per top-level directory in
 *    sequence, so peak memory is the largest group (tests/, about 3.1 GB).
 *  - files: lints the changed source files.
 *  - skip: no lintable file changed.
 * A type change in a source file is not a trigger, so a floating promise in an
 * unchanged caller is missed here; CI's full `npm run lint` still gates merges.
 *
 * Flags: `--dry-run` prints the plan as JSON and runs nothing; `--changed <file>`
 * reads the changed paths (one per line) instead of running git.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const LINTABLE = /\.(ts|tsx|mts|cts)$/;
const FULL_TRIGGERS = [
  /^eslint\.config\.mjs$/,
  /^eslint-rules\//,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)package(-lock)?\.json$/,
  /\.d\.ts$/,
];

const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = (s) => s.split(/\r?\n/).filter(Boolean);
// git -z output: NUL-terminated, never quoted (the default core.quotePath wraps non-ASCII names in quotes).
const nulSeparated = (s) => s.split('\0').filter(Boolean);

// null means "no base to diff against" (missing origin/main, no common ancestor).
function changedPaths() {
  const input = flag('--changed');
  if (input) {
    return lines(readFileSync(input, 'utf8'));
  }
  const base = git('merge-base', 'HEAD', 'origin/main');
  if (base.status !== 0) {
    return null;
  }
  const diff = git('diff', '-z', '--name-only', '--diff-filter=ACMR', `${base.stdout.trim()}..HEAD`);
  if (diff.status !== 0) {
    return null;
  }
  return nulSeparated(diff.stdout);
}

function planFor(changed) {
  if (changed === null || changed.some((f) => FULL_TRIGGERS.some((re) => re.test(f)))) {
    const groups = {};
    for (const f of nulSeparated(git('ls-files', '-z').stdout)) {
      if (LINTABLE.test(f) && existsSync(join(root, f))) {
        const group = f.includes('/') ? f.slice(0, f.indexOf('/')) : '.';
        (groups[group] ??= []).push(f);
      }
    }
    return { mode: 'full', groups };
  }
  const files = changed.filter((f) => LINTABLE.test(f));
  return files.length > 0 ? { mode: 'files', files } : { mode: 'skip' };
}

const plan = planFor(changedPaths());
if (args.includes('--dry-run')) {
  // Synchronous write: process.exit would truncate a large piped console.log.
  writeSync(1, `${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}
if (plan.mode === 'skip') {
  console.log('lint-changed: no lintable files changed, skipping');
  process.exit(0);
}

// 6144, not lint's 12288: it must stay above the tests/ group's 3.1 GB RSS.
const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' };
const run = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { cwd: root, env, stdio: 'inherit' }).status ?? 1;

console.log(`lint-changed: ${plan.mode} mode`);
if (run('npm', ['run', 'lint:prebuild']) !== 0) {
  process.exit(1);
}
const batches = plan.mode === 'full' ? Object.entries(plan.groups) : [['changed files', plan.files]];
let failed = false;
for (const [name, files] of batches) {
  console.log(`lint-changed: linting ${files.length} files (${name})`);
  if (run('npx', ['eslint', '--no-warn-ignored', ...files]) !== 0) {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
