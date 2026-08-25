/**
 * Pin the deploy matrix to the targets a merge actually changed (BS#2264).
 *
 * # The failure this guards against
 *
 * `deploy-base.yml`'s `setup` job picks the deploy matrix with
 * `turbo ls --affected`, diffing `github.event.before..github.sha`. That
 * matrix drives three jobs per target -- `handle-git-tags`, `build`,
 * `deploy` -- so its width is multiplied by three, and GitHub bills a
 * one-minute minimum per job. At 50 targets that is 155 jobs and ~266
 * billed minutes for ~156 minutes of work.
 *
 * `turbo --affected` fails OPEN. When it cannot resolve the SCM range it
 * prints a *warning*, not an error, and reports every package as affected:
 *
 *   WARNING  unable to detect git range, assuming all files have changed:
 *            Git error: fatal: no merge base found
 *
 * From 2026-03-08 (9ea9846d) to 2026-08-24 that warning fired on every
 * single run. The commit that introduced the `github.event.before` range
 * deleted `fetch-depth: 2` from this job's checkout in the same diff,
 * replacing it with `git fetch origin <before> --depth=1`.
 * `actions/checkout` defaults to `fetch-depth: 1`, so the result was two
 * disjoint shallow grafts with no common ancestor -- `git merge-base`
 * exits 1, turbo bails, and every merge deployed all 50 targets.
 *
 * Measured 2026-08-24: `deploy-auto.yml` billed 22,050 minutes in one
 * period -- 43.8% of the WXYC org's entire Actions spend, more than
 * dj-site's e2e and CI suites combined. Merges titled `docs(...)` and
 * `plans: reframe the 2.2 spike memo to findings only` each rebuilt and
 * redeployed all 47 ETL jobs. Reconstructing all 126 push ranges in the
 * period, 15% needed no deploy at all and ~48% of the minutes were waste.
 * The same fan-out cut 5,853 git tags in August against 105 in March.
 *
 * The bug survived five months because the fallback is silent and safe:
 * over-deploying looks exactly like working. So this file pins both
 * halves -- the checkout depth that makes the range resolvable, and the
 * guard that refuses to spend 266 minutes without saying why.
 *
 * # Why this file is a `readFileSync` test, and what that costs
 *
 * It reads workflow YAML as text, so Jest's dependency graph has no edge
 * from `deploy-base.yml` to this spec; the job running it has to be
 * triggered by a change to the files it reads. `detect-changes`' `src`
 * filter globs `.github/workflows/**`, which is what makes that hold --
 * see `ci-node-modules-cache.test.ts`, which depends on the same glob.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDir = path.join(repoRoot, '.github/workflows');
const deployBase = fs.readFileSync(path.join(workflowDir, 'deploy-base.yml'), 'utf-8');

/** Drop comment-only lines: every check here must read YAML, not the prose above it. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * The body of one top-level job in `deploy-base.yml`, comments stripped.
 * Jobs are indented two spaces under `jobs:`, so a job ends at the next
 * line with exactly that indent.
 */
function jobBody(name: string): string {
  const lines = withoutComments(deployBase).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l));
  if (start === -1) throw new Error(`job '${name}' not found in deploy-base.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

/** The `- uses: actions/checkout@vN` step chunks inside one job. */
function checkoutSteps(name: string): string[] {
  const lines = jobBody(name).split('\n');
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s+- (name|uses|id|if):/.test(line)) starts.push(i);
  });
  return starts
    .map((s, i) => lines.slice(s, starts[i + 1] ?? lines.length).join('\n'))
    .filter((step) => /uses:\s*actions\/checkout@/.test(step));
}

describe('the deploy matrix is scoped to what the merge changed (BS#2264)', () => {
  const setup = jobBody('setup');

  it('finds the setup job and its checkout', () => {
    // If the parser stops matching -- a rename, a re-indent -- every
    // assertion below passes vacuously, which is the shape of failure
    // this whole file exists to catch.
    expect(setup).toContain('turbo ls --affected');
    expect(checkoutSteps('setup')).toHaveLength(1);
  });

  it('checks out enough history for the merge base to resolve', () => {
    // The defect: no `fetch-depth`, so `actions/checkout` uses its
    // default of 1 and `github.event.before` has no ancestry to HEAD.
    // Reproduced against this repo on 2026-08-24 -- `git merge-base`
    // exits 1 under depth 1, exits 0 once unshallowed.
    expect(checkoutSteps('setup')[0]).toMatch(/fetch-depth:\s*0\b/);
  });

  it('does not reintroduce the shallow single-commit base fetch', () => {
    // `git fetch origin <before> --depth=1` on top of a depth-1 checkout
    // is what produced the two disjoint grafts. With `fetch-depth: 0` the
    // base commit is already present and this step is worse than useless:
    // it looks like it makes the range work.
    expect(withoutComments(deployBase)).not.toMatch(/git fetch origin .*--depth=1/);
  });

  it('refuses to fan out to every target without saying so', () => {
    // turbo's fail-open is only safe when it is loud. The guard has to
    // key on the warning turbo actually prints, so quote it exactly.
    expect(setup).toContain('assuming all files have changed');
    expect(setup).toMatch(/::(error|warning)/);
  });

  it('distinguishes an unresolvable range from a broken one', () => {
    // Two different situations. A force-push or a branch-creation push
    // genuinely has no usable base -- deploy everything, warn, carry on.
    // A range that IS resolvable and still fails to diff is a regression
    // of this very bug, and must stop the run rather than quietly bill
    // 266 minutes. Without the `--is-ancestor` check there is no way to
    // tell them apart.
    expect(setup).toContain('merge-base --is-ancestor');
    expect(setup).toMatch(/exit 1/);
  });
});
