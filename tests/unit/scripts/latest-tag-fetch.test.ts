/**
 * Keep `latest_tag` off the network, and keep the tags it reads reachable
 * (BS#2267).
 *
 * # The failure this guards against
 *
 * This repo carries 18,408 deploy tags (`refs/tags/<target>/v<semver>`),
 * one per target per deploy. `.github/actions/latest_tag/action.yml` ran
 * `git fetch --tags` unconditionally before reading them, and
 * `deploy-base.yml` invokes that action once per target in the
 * `handle-git-tags` matrix -- so a full fan-out paid for that fetch ~50
 * times in a single run.
 *
 * The fetch was not merely over-broad, it was dead. `actions/checkout@v7`
 * with `fetch-tags: true` does not rely on git's tag auto-following; it
 * pushes `+refs/tags/*:refs/tags/*` onto the fetch refspec outright
 * (`src/ref-helper.ts`, `getRefSpec`), while `fetch()` now passes
 * `--no-tags` unconditionally and leaves tag selection entirely to that
 * refspec (`src/git-command-manager.ts`). Every tag is therefore already
 * in the workspace by the time the composite action runs.
 *
 * Measured against this repo on 2026-08-24, replaying checkout v7's exact
 * command (`git -c protocol.version=2 fetch --no-tags --prune
 * --no-recurse-submodules --depth=1 origin '+refs/tags/*:refs/tags/*'
 * '+<sha>:refs/remotes/origin/main'`):
 *
 *   - after checkout:              18,408 tags present
 *   - after `git fetch --tags`:    18,408 tags present -- zero new refs
 *   - cost of that no-op fetch:    1.4-3.2s wall, three consecutive runs
 *
 * What it does cost is a full ref advertisement every time: 1,598,271
 * bytes for this repo, of which 1,519,824 (~1.45 MiB) is the tag
 * namespace. And because `actions/checkout` sets the remote up with a
 * plain `git remote add origin` (`git-command-manager.ts`, `remoteAdd`),
 * `remote.origin.fetch` keeps its default `+refs/heads/*:...` -- so a
 * bare `git fetch --tags` also pulled down every branch head, which this
 * action never reads.
 *
 * # Why the checkout assertion is the load-bearing one
 *
 * Deleting the fetch makes the action a pure reader of whatever the
 * enclosing job checked out. If a job ever invokes `latest_tag` behind a
 * checkout that does not supply tags, `git tag -l` returns nothing, the
 * action reports `is_initial=true`, and `deploy-base.yml` restarts that
 * target's versioning at `v0.1.0` -- re-tagging over history and
 * destroying the rollback ladder `deploy-manual.yml` reads. That failure
 * is silent and green, so it gets an assertion rather than a comment.
 *
 * # Why the glob is anchored to the namespace separator
 *
 * `git tag -l "${TARGET_APP}*"` is a prefix glob, so a target whose name
 * prefixes another's would resolve its sibling's tags and bump the wrong
 * ladder. Verified 2026-08-24: 50 targets under `apps/` and `jobs/`, 53
 * distinct tag namespaces, no name is a prefix of any other, and all
 * 18,408 tags match `<namespace>/v<semver>` -- so the two globs resolve
 * identically for all 53 namespaces today. The anchored form costs
 * nothing and closes the hazard before someone adds `library-etl-v2`
 * alongside `library-etl`.
 *
 * # Why this file is a `readFileSync` test, and what that costs
 *
 * It reads action and workflow YAML as text, so Jest's dependency graph
 * has no edge from those files to this spec; the job running it has to be
 * triggered by a change to the files it reads. `ci-node-modules-cache.test.ts`
 * and `deploy-affected-targets.test.ts` rely on `detect-changes`' `src`
 * filter globbing `.github/workflows/**` for that. The file this spec is
 * really about lives one directory over, under `.github/actions/`, which
 * that filter did not cover -- so an action-only PR (a revert of exactly
 * the change this guards) would have skipped `unit-tests` and reported the
 * required check as `skipped`, which branch protection accepts. Adding
 * `.github/actions/**` to `src` is half of this fix; the last assertion
 * below is what keeps it there.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDir = path.join(repoRoot, '.github/workflows');
const actionPath = path.join(repoRoot, '.github/actions/latest_tag/action.yml');
const latestTagAction = fs.readFileSync(actionPath, 'utf-8');

/** The `uses:` path every consumer of the composite action references. */
const ACTION_USES = './.github/actions/latest_tag';

/** Drop comment-only lines: every check here must read YAML, not the prose above it. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function workflowFiles(): string[] {
  return fs
    .readdirSync(workflowDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

/** Split a chunk of YAML into step-sized pieces. A step starts at `- <key>:`. */
function stepsOf(text: string): string[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s+- (name|uses|id|if):/.test(line)) starts.push(i);
  });
  return starts.map((s, i) => lines.slice(s, starts[i + 1] ?? lines.length).join('\n'));
}

/**
 * Every top-level job in a workflow, as `[name, body]`. Jobs are indented
 * two spaces under `jobs:`, so a job ends at the next line with exactly
 * that indent. Deliberately keyed on indentation rather than on a list of
 * job names -- `handle-git-tags` is the only caller today, and this should
 * still cover the next one.
 */
function jobsOf(text: string): [string, string][] {
  const lines = withoutComments(text).split('\n');
  const out: [string, string][] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (!m) return;
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((l) => /^ {2}\S/.test(l));
    out.push([m[1], rest.slice(0, end === -1 ? rest.length : end).join('\n')]);
  });
  return out;
}

/** Jobs, across every workflow, that invoke the `latest_tag` composite action. */
const callers: { file: string; job: string; body: string }[] = workflowFiles().flatMap((file) => {
  const text = fs.readFileSync(path.join(workflowDir, file), 'utf-8');
  return jobsOf(text)
    .filter(([, body]) => body.includes(ACTION_USES))
    .map(([job, body]) => ({ file, job, body }));
});

describe('latest_tag reads the tags checkout already fetched (BS#2267)', () => {
  it('finds the action and its tag-resolution step', () => {
    // If the parser stops matching -- a rename, a re-indent, a rewrite of
    // the run block -- every assertion below passes vacuously, which is
    // exactly the shape of failure this file exists to catch.
    expect(latestTagAction).toContain('id: get_tag');
    expect(withoutComments(latestTagAction)).toMatch(/git tag -l/);
  });

  it('does not fetch from the network', () => {
    // The measured defect: a no-op `git fetch --tags` per matrix job,
    // each one a full ~1.5 MiB ref advertisement returning zero new refs.
    // Any `git fetch` here is redundant with the enclosing checkout, so
    // ban the verb rather than one spelling of its arguments.
    expect(withoutComments(latestTagAction)).not.toMatch(/\bgit fetch\b/);
  });

  it('anchors the tag glob to the namespace separator', () => {
    // `"${TARGET_APP}*"` would let a target whose name prefixes another's
    // resolve the sibling's ladder and bump the wrong version. Safe today
    // only because no target name is a prefix of another.
    expect(withoutComments(latestTagAction)).toContain('git tag -l "${TARGET_APP}/v*"');
    expect(withoutComments(latestTagAction)).not.toMatch(/git tag -l "\$\{TARGET_APP\}\*"/);
  });
});

describe('every latest_tag caller checks out the tags it will read (BS#2267)', () => {
  it('finds at least one caller', () => {
    // Parser sanity again: an empty `callers` list makes the assertion
    // below trivially true, and it is the one that keeps the action's
    // now-unconditional dependence on the enclosing checkout honest.
    expect(callers.length).toBeGreaterThanOrEqual(1);
    expect(callers.map((c) => `${c.file}:${c.job}`)).toContain('deploy-base.yml:handle-git-tags');
  });

  it.each(callers.map((c) => [`${c.file}:${c.job}`, c] as const))(
    '%s checks out with tags present',
    (_label, caller) => {
      // Without tags in the workspace, `git tag -l` is empty, the action
      // reports `is_initial=true`, and the target's versioning restarts at
      // v0.1.0 -- re-tagging over the rollback ladder `deploy-manual.yml`
      // reads. `fetch-tags: true` pulls `+refs/tags/*:refs/tags/*`;
      // `fetch-depth: 0` pulls the tags regardless of that input.
      const checkouts = stepsOf(caller.body).filter((s) => /uses:\s*actions\/checkout@/.test(s));
      expect(checkouts.length).toBeGreaterThanOrEqual(1);
      const suppliesTags = checkouts.some((s) => /fetch-tags:\s*true\b/.test(s) || /fetch-depth:\s*0\b/.test(s));
      expect(suppliesTags).toBe(true);
    }
  );
});

describe('the guard is reachable from the action it reads (BS#2267)', () => {
  const testWorkflow = withoutComments(fs.readFileSync(path.join(workflowDir, 'test.yml'), 'utf-8'));

  it("detect-changes' src filter globs the composite-action directory", () => {
    // Without this, a PR that edits only `.github/actions/latest_tag/`
    // skips `unit-tests`, this spec never runs, and the required check
    // reports `skipped` -- which branch protection treats as passing. The
    // same hole has already been found twice one directory over (BS#1807,
    // BS#2256); this is the third instance, so glob the directory rather
    // than naming the file.
    expect(testWorkflow).toContain("- '.github/actions/**'");
  });
});
