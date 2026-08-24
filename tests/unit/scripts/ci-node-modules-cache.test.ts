/**
 * Pin the GitHub Actions `node_modules` cache to a single, restorable key
 * (BS#2256).
 *
 * # The failure this guards against
 *
 * GHA scopes every cache entry to the ref that wrote it. A `pull_request`
 * run writes into `refs/pull/<N>/merge`, which only that one PR can read.
 * The one scope every PR *can* read is the default branch's -- so the
 * default branch is the only scope a cache can be shared through.
 *
 * `test.yml` triggers only on `pull_request` and keyed its cache
 * `node-modules-*`. `deploy-base.yml` runs on push to `main` but keyed the
 * same directory, built from the same lockfile hash, as
 * `deploy-node-modules-*`. One prefix apart, so CI never restored what the
 * merge had just written: each PR missed, ran `npm ci`, and saved another
 * ~145 MB copy into a scope only it could read.
 *
 * Measured 2026-08-23 before the fix: 194 entries / 10.59 GB against
 * GitHub's 10 GB per-repo cap, so the store was permanently evicting.
 * 49 of the 50 `node-modules-*` entries were PR-scoped (6.93 GB); one
 * lockfile hash had TEN identical copies, one per PR. `npm ci` ran on
 * 13 of 13 sampled branches, 25-34s each.
 *
 * `nightly-tests.yml` also writes this key on `main` -- a `schedule`
 * trigger runs on the default branch -- so it was never true that nothing
 * could populate the shared scope. But nightly fires once a day and its
 * entry goes stale as soon as the lockfile moves, which is exactly what
 * had happened: main held a single `node-modules-*` entry, at a stale
 * hash. The per-merge writer is what keeps a current entry there.
 *
 * # Why this file is a `readFileSync` test, and what that costs
 *
 * It reads workflow YAML as text, so Jest's dependency graph has no edge
 * from these workflows to this spec. That is fine now -- BS#2255 moved CI
 * to the full unit suite -- but it does mean the job running this spec has
 * to be *triggered* by a change to the files it reads. `detect-changes`'s
 * `src` filter therefore globs `.github/workflows/**`; narrowing it back
 * to individual files re-opens the hole (BS#1807, then BS#2256).
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDir = path.join(repoRoot, '.github/workflows');

/**
 * The single key every `node_modules` cache step must use. Keep the
 * `runner.os` and lockfile-hash components -- they are what make the entry
 * safe to share across workflows.
 */
const CANONICAL_KEY = "node-modules-${{ runner.os }}-node24-${{ hashFiles('package-lock.json') }}";

/**
 * Exact number of steps expected to cache `node_modules`, as of BS#2256:
 * three jobs in test.yml, plus deploy-base.yml and nightly-tests.yml.
 *
 * Pinned exactly, not as a floor. A floor cannot catch a step dropping OUT
 * of the checked set -- rewriting one `path: node_modules` as a block list
 * to add a second directory, say -- which would silently exempt it from
 * every assertion below while they all kept passing. Changing this number
 * should be a deliberate edit with a look at the key.
 */
const EXPECTED_NODE_MODULES_CACHE_STEPS = 5;

interface Step {
  file: string;
  text: string;
}

function workflowFiles(): string[] {
  return fs
    .readdirSync(workflowDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

/**
 * Drop comment-only lines. Every check here must read YAML, not prose --
 * the first cut of this guard tripped on its own explanatory comments,
 * which quote the retired `deploy-node-modules-*` prefix verbatim.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Split a workflow into step-sized chunks. A step starts at `- <key>:`. */
function stepsOf(file: string): Step[] {
  const lines = fs.readFileSync(path.join(workflowDir, file), 'utf-8').split('\n');
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s+- (name|uses|id|if):/.test(line)) starts.push(i);
  });
  return starts.map((start, i) => ({
    file,
    text: lines.slice(start, starts[i + 1] ?? lines.length).join('\n'),
  }));
}

const allSteps: Step[] = workflowFiles().flatMap(stepsOf);

/** The value of a scalar `with:` input, or undefined when absent/a block. */
function scalar(step: Step, key: string): string | undefined {
  const m = withoutComments(step.text).match(new RegExp(`^\\s*${key}:[ \\t]*(\\S.*?)\\s*$`, 'm'));
  return m?.[1];
}

/**
 * Every path a cache step covers, handling both `path: node_modules` and
 * the block form:
 *
 *   path: |
 *     node_modules
 *     .cache
 */
function cachedPaths(step: Step): string[] {
  const lines = withoutComments(step.text).split('\n');
  const i = lines.findIndex((l) => /^\s*path:/.test(l));
  if (i === -1) return [];
  const head = lines[i].replace(/^\s*path:[ \t]*/, '').trim();
  if (head && head !== '|' && head !== '|-' && head !== '>') return [head];

  const indent = (lines[i].match(/^\s*/) ?? [''])[0].length;
  const out: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (!line.trim()) continue;
    if ((line.match(/^\s*/) ?? [''])[0].length <= indent) break;
    out.push(line.trim().replace(/^-\s*/, ''));
  }
  return out;
}

const cacheSteps = allSteps.filter((s) => /uses: actions\/cache@/.test(s.text));
const nodeModulesCacheSteps = cacheSteps.filter((s) => cachedPaths(s).includes('node_modules'));

describe('the node_modules cache is one shared, restorable key (BS#2256)', () => {
  it('finds every node_modules cache step', () => {
    // If the parser silently matches nothing (or stops matching a step
    // that was reworded), every assertion below passes vacuously -- the
    // exact shape of failure BS#2249 was about.
    expect(cacheSteps.length).toBeGreaterThanOrEqual(EXPECTED_NODE_MODULES_CACHE_STEPS);
    expect(nodeModulesCacheSteps.map((s) => s.file).sort()).toEqual([
      'deploy-base.yml',
      'nightly-tests.yml',
      'test.yml',
      'test.yml',
      'test.yml',
    ]);
    expect(nodeModulesCacheSteps).toHaveLength(EXPECTED_NODE_MODULES_CACHE_STEPS);
  });

  it('caches node_modules from a workflow that runs on the default branch', () => {
    // The whole point is cross-PR sharing, and only a default-branch run
    // can write the scope PRs read from. `deploy-base.yml` (push to main)
    // is the per-merge writer; `nightly-tests.yml` (schedule) is the daily
    // one. If neither still caches node_modules, the shared key is
    // unreachable again and this guard is proving nothing.
    const files = new Set(nodeModulesCacheSteps.map((s) => s.file));
    expect([...files].some((f) => f === 'deploy-base.yml' || f === 'nightly-tests.yml')).toBe(true);
    expect(files.has('deploy-base.yml')).toBe(true);
  });

  it('uses one identical key everywhere', () => {
    // Report file + key so a failure names the offender directly.
    const offenders = nodeModulesCacheSteps
      .filter((s) => scalar(s, 'key') !== CANONICAL_KEY)
      .map((s) => `${s.file}: ${scalar(s, 'key')}`);
    expect(offenders).toEqual([]);
  });

  it('never reintroduces a workflow-specific prefix', () => {
    // `deploy-node-modules-*` was the original defect.
    const offenders = workflowFiles().filter((f) =>
      /deploy-node-modules-|test-node-modules-|nightly-node-modules-/.test(
        withoutComments(fs.readFileSync(path.join(workflowDir, f), 'utf-8'))
      )
    );
    expect(offenders).toEqual([]);
  });

  it('does not fall back to a stale tree via restore-keys', () => {
    // A partial-match restore would hand a job a node_modules built from a
    // different lockfile; exact-match plus `npm ci` on miss is the right
    // trade.
    for (const step of nodeModulesCacheSteps) {
      expect(withoutComments(step.text)).not.toContain('restore-keys');
    }
  });
});

describe('the guard is reachable from the workflows it reads (BS#2256)', () => {
  const testWorkflow = withoutComments(fs.readFileSync(path.join(workflowDir, 'test.yml'), 'utf-8'));

  it("detect-changes' src filter globs the whole workflow directory", () => {
    // Without this, a PR that edits only a workflow skips `unit-tests`,
    // this spec never runs, and the required check reports `skipped` --
    // which branch protection treats as passing. Enumerating individual
    // workflow files here has already failed twice (BS#1807, BS#2256).
    expect(testWorkflow).toContain("- '.github/workflows/**'");
  });
});
