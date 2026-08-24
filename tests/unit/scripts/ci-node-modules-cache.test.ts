/**
 * Pin the GitHub Actions `node_modules` cache to a single, restorable key
 * (BS#2256).
 *
 * # The failure this guards against
 *
 * GHA scopes every cache entry to the ref that wrote it. A `pull_request`
 * run writes into `refs/pull/<N>/merge`, which only that one PR can read.
 * The one scope every PR *can* read is the default branch's. So a cache
 * that is only ever written by `pull_request` workflows can never be
 * restored by anything: each PR misses, runs `npm ci`, and saves yet
 * another ~145 MB copy of byte-identical content into its own private
 * scope.
 *
 * That is exactly what happened here. `test.yml` triggers only on
 * `pull_request`, and it keyed its cache `node-modules-*`. `deploy-base.yml`
 * runs on push to `main` — the one workflow that *can* populate the shared
 * scope — but keyed the same directory, built from the same lockfile, as
 * `deploy-node-modules-*`. One prefix apart, so nothing ever restored.
 *
 * Measured 2026-08-23 before the fix: 194 entries / 10.59 GB against
 * GitHub's 10 GB per-repo cap, so the store was permanently evicting.
 * 49 of the 50 `node-modules-*` entries were PR-scoped (6.93 GB); one
 * lockfile hash had TEN identical copies, one per PR. `npm ci` ran on
 * 13 of 13 sampled branches, 25-34s each.
 *
 * # The invariants
 *
 * 1. Every cache step that caches the `node_modules` directory uses the
 *    SAME key, so the default-branch write is restorable by every PR.
 *    A prefix that varies per workflow silently disables the whole cache.
 * 2. No `restore-keys` on those steps. A partial-match restore would hand
 *    a job a `node_modules` built from a different lockfile; exact-match
 *    plus a clean `npm ci` on miss is the correct trade.
 * 3. Every `actions/setup-node` makes an explicit choice about npm
 *    caching. `package-manager-cache` defaults to TRUE whenever
 *    `package.json` declares `packageManager` (it declares npm@11.11.0),
 *    so every setup-node silently cached ~169 MB of `~/.npm` on top of
 *    the 145 MB `node_modules` tarball -- keyed on the same lockfile hash.
 *    Same key means they always hit and miss together, so the `~/.npm`
 *    copy can never rescue a `node_modules` miss. It is pure weight.
 *    Jobs that install a subset of deps without caching `node_modules`
 *    (`migrate-dryrun`, the schema-shape self-test) DO benefit, and opt
 *    in explicitly with `cache: 'npm'`.
 *
 * Source-grep test (no docker, no PG), in the style of the adjacent
 * `ci-env-surface-parity.test.ts` and `ci-unit-tests-full-suite.test.ts`.
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
 * setup-node steps allowed to keep npm's download cache, because they
 * install dependencies WITHOUT restoring a `node_modules` tarball, so the
 * `~/.npm` copy is the only cache they have. Each must opt in explicitly
 * with `cache: 'npm'`.
 */
const NPM_CACHE_OPT_IN = "'npm'";

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

/**
 * Drop comment-only lines. Every check below must read YAML, not prose --
 * the first cut of this guard tripped on its own explanatory comments,
 * which quote both `cache: 'npm'` and the retired `deploy-node-modules-*`
 * prefix verbatim.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The value of a scalar `with:` input, or undefined when absent/a block. */
function scalar(step: Step, key: string): string | undefined {
  const m = withoutComments(step.text).match(new RegExp(`^\\s*${key}:[ \\t]*(\\S.*?)\\s*$`, 'm'));
  return m?.[1];
}

const cacheSteps = allSteps.filter((s) => /uses: actions\/cache@/.test(s.text));
const nodeModulesCacheSteps = cacheSteps.filter((s) => scalar(s, 'path') === 'node_modules');
const setupNodeSteps = allSteps.filter((s) => /uses: actions\/setup-node@/.test(s.text));

/** Label each setup-node by its ordinal WITHIN its file, so a failure points somewhere. */
const labelledSetupNodeSteps: ReadonlyArray<readonly [string, Step]> = (() => {
  const seen = new Map<string, number>();
  return setupNodeSteps.map((s) => {
    const n = (seen.get(s.file) ?? 0) + 1;
    seen.set(s.file, n);
    return [`${s.file} setup-node #${n}`, s] as const;
  });
})();

describe('the node_modules cache is one shared, restorable key (BS#2256)', () => {
  it('finds the cache steps at all (parser sanity)', () => {
    // If the parser silently matches nothing, every assertion below passes
    // vacuously -- the exact shape of failure BS#2249 was about.
    expect(cacheSteps.length).toBeGreaterThanOrEqual(4);
    expect(nodeModulesCacheSteps.length).toBeGreaterThanOrEqual(4);
    expect(setupNodeSteps.length).toBeGreaterThanOrEqual(6);
  });

  it('caches node_modules from more than one workflow file', () => {
    // The whole point is cross-workflow sharing: a PR-only cache is
    // unrestorable. If this ever collapses to a single file, the guard
    // below stops proving anything.
    const files = [...new Set(nodeModulesCacheSteps.map((s) => s.file))];
    expect(files.length).toBeGreaterThanOrEqual(2);
    // deploy-base.yml is the only workflow that runs on push-to-main, so it
    // is the only one that can populate the scope PRs restore from.
    expect(files).toContain('deploy-base.yml');
  });

  it('uses one identical key everywhere', () => {
    // Report file + key so a failure names the offender directly.
    const offenders = nodeModulesCacheSteps
      .filter((s) => scalar(s, 'key') !== CANONICAL_KEY)
      .map((s) => `${s.file}: ${scalar(s, 'key')}`);
    expect(offenders).toEqual([]);
  });

  it('never reintroduces a workflow-specific prefix', () => {
    // `deploy-node-modules-*` was the original defect: deploy-base.yml is
    // the ONLY workflow running on push-to-main, so its prefix decided
    // whether the default-branch scope got a restorable entry. It did not.
    const offenders = workflowFiles().filter((f) =>
      /deploy-node-modules-|test-node-modules-|nightly-node-modules-/.test(
        withoutComments(fs.readFileSync(path.join(workflowDir, f), 'utf-8'))
      )
    );
    expect(offenders).toEqual([]);
  });

  it('does not fall back to a stale tree via restore-keys', () => {
    for (const step of nodeModulesCacheSteps) {
      expect(withoutComments(step.text)).not.toContain('restore-keys');
    }
  });
});

describe('every setup-node makes an explicit npm-cache choice (BS#2256)', () => {
  it('package.json still declares packageManager, so the default is ON', () => {
    // The rationale for invariant 3 evaporates if this field goes away --
    // setup-node would stop auto-caching and the explicit `false` would be
    // redundant rather than load-bearing.
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    expect(pkg.packageManager).toMatch(/^npm@/);
  });

  it.each(labelledSetupNodeSteps)('%s either disables the npm cache or opts in explicitly', (_label, step) => {
    const disabled = scalar(step, 'package-manager-cache') === 'false';
    const optedIn = scalar(step, 'cache') === NPM_CACHE_OPT_IN;
    expect(disabled || optedIn).toBe(true);
    // Never both -- that reads as a contradiction at the call site.
    expect(disabled && optedIn).toBe(false);
  });
});
