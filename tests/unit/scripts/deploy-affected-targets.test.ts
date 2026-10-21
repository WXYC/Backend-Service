/**
 * Pin the deploy matrix to the targets a merge actually changed (BS#2264).
 *
 * # The failure this guards against
 *
 * `deploy-base.yml`'s `setup` job picks the deploy matrix with
 * `turbo ls --affected`, diffing each target's last deployed commit against
 * `github.sha` (`scripts/deploy-affected-targets.sh`, BS#3564; it used to
 * diff `github.event.before..github.sha`). That
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

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findStep, loadWorkflow, makeYqShim, runBashScript, sliceScript } from '../../utils/workflow-step';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDir = path.join(repoRoot, '.github/workflows');
const deployBase = fs.readFileSync(path.join(workflowDir, 'deploy-base.yml'), 'utf-8');
const affectedScript = fs.readFileSync(path.join(repoRoot, 'scripts/deploy-affected-targets.sh'), 'utf-8');
const turboBin = path.join(repoRoot, 'node_modules/.bin');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
};

const write = (root: string, rel: string, content: string, mode?: number) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content, mode === undefined ? undefined : { mode });
};

/** A fresh git repo in a temp dir, with an identity and no signing. */
const initRepo = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, 'init', '-q', '-b', 'trunk');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
};

/** Parse a step's stdout for the `RESULT=<json>` line the sliced scripts print. */
const resultOf = (r: { status: number | null; stdout: string; stderr: string }) => {
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT='));
  return { status: r.status, out: r.stdout + r.stderr, targets: line ? JSON.parse(line.slice(7)) : null };
};

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
  // The range logic lives in the script `Detect Build Target` calls.
  const detection = `${setup}\n${withoutComments(affectedScript)}`;

  it('finds the setup job and its checkout', () => {
    // If the parser stops matching -- a rename, a re-indent -- every
    // assertion below passes vacuously, which is the shape of failure
    // this whole file exists to catch.
    expect(setup).toContain('scripts/deploy-affected-targets.sh');
    expect(detection).toContain('turbo ls --affected');
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
    expect(detection).toContain('assuming all files have changed');
    expect(detection).toMatch(/::(error|warning)/);
  });

  it('distinguishes an unresolvable range from a broken one', () => {
    // Two different situations. A force-push or a branch-creation push
    // genuinely has no usable base -- deploy everything, warn, carry on.
    // A range that IS resolvable and still fails to diff is a regression
    // of this very bug, and must stop the run rather than quietly bill
    // 266 minutes. Without the `--is-ancestor` check there is no way to
    // tell them apart.
    expect(detection).toContain('merge-base --is-ancestor');
    expect(detection).toMatch(/exit 1/);
  });

  it('skips an affected target that has no root Dockerfile', () => {
    // A retired job keeps its workspace -- its source stays in the tree for
    // the precondition-guard pattern and its unit tests still import it --
    // but loses `Dockerfile.<name>`, which is what stops `Manual Build &
    // Deploy` producing a runnable image. turbo still reports the workspace
    // as affected, so without this filter the matrix schedules a `build`
    // that hard-fails on the missing file, which fails the run and SKIPS
    // `deploy` -- taking every unrelated target on the same merge down with
    // it. Happened on 9fbbc636 (BS#2281).
    expect(setup).toContain('Dockerfile.$TARGET');
    expect(setup).toMatch(/BUILDABLE/);
  });

  it('warns per skipped target rather than dropping it silently', () => {
    // Deleting the Dockerfile of a job that SHOULD still deploy is a real
    // mistake, and a silent filter would make it look like a clean deploy --
    // the same "over-deploying looks exactly like working" shape that let
    // BS#2264 survive five months, inverted.
    expect(setup).toContain('::warning title=Skipping target with no Dockerfile');
  });

  it('leaves the explicit workflow_dispatch target unfiltered', () => {
    // An operator who dispatches a retired target by name should get the
    // loud build failure -- that refusal is the point of removing the
    // Dockerfile. Only the auto-detected matrix is filtered, so the filter
    // must sit inside the `else` branch, after turbo has produced TARGETS.
    const dispatchArm = setup.slice(0, setup.indexOf('Detecting affected app targets'));
    expect(dispatchArm).toContain('Using provided target');
    expect(dispatchArm).not.toContain('BUILDABLE');
  });

  describe('one-shot filtering on the automatic path', () => {
    const autoArm = setup.slice(setup.indexOf('Detecting affected app targets'));
    const liveStep = withoutComments(deployBase)
      .split('name: Detect Live Target Repos')[1]
      .split(/\n\s+- name:/)[0];

    it('reads job-type only behind the package.json existence check', () => {
      // Apps have no jobs/<t>/package.json, and a bare `yq` on a missing file
      // fails the step under `bash -e`.
      expect(autoArm).toMatch(/\[ -f "jobs\/\$TARGET\/package\.json" \]/);
      expect(autoArm).toContain('.["job-type"]');
    });

    it('announces the one-shots it skipped', () => {
      expect(autoArm).toContain('::notice title=Skipping one-shot jobs');
      expect(autoArm).toContain('rebuild=true');
    });

    it('does not filter the dispatch arm or Detect Live Target Repos', () => {
      const dispatchArm = setup.slice(0, setup.indexOf('Detecting affected app targets'));
      expect(dispatchArm).not.toContain('one-shot');
      expect(liveStep).not.toContain('one-shot');
    });
  });
});

/**
 * Behavioral tests (BS#2909): run the real filter loop from the `Detect Build
 * Target` step against a throwaway git repo, so the push range is real. The
 * loop is sliced out of the parsed step's `run:` script (from `BUILDABLE='[]'`
 * to the empty-matrix check) and executed with `bash -eo pipefail`, the way
 * GitHub runs it. `yq` is not installed on dev machines, so a shim backed by
 * jq (the manifests are JSON, and the expression is valid jq) stands in.
 */
describe('one-shot filter behavior', () => {
  const stepRun = findStep(loadWorkflow('deploy-base.yml').jobs.setup, 'Detect Build Target').run;
  const filterScript =
    sliceScript(stepRun, "BUILDABLE='[]'", 'if [ "$TARGETS" = "[]" ]') + '\necho "RESULT=$TARGETS"\n';
  const shimDir = makeYqShim();

  let root: string;
  let base: string;
  beforeAll(() => {
    root = initRepo('deploy-filter-');
    const oneShot = JSON.stringify({ 'job-type': 'one-shot' });
    for (const t of ['oneshot-own', 'oneshot-docker', 'oneshot-dep']) {
      write(root, `jobs/${t}/package.json`, oneShot);
      write(root, `jobs/${t}/index.ts`, 'v1');
      write(root, `Dockerfile.${t}`, 'v1');
    }
    write(root, 'jobs/cron-explicit/package.json', JSON.stringify({ 'job-type': 'cron' }));
    write(root, 'jobs/cron-default/package.json', JSON.stringify({}));
    for (const t of ['cron-explicit', 'cron-default', 'app-one']) write(root, `Dockerfile.${t}`, 'v1');
    write(root, 'apps/app-one/index.ts', 'v1');
    write(root, 'shared/lib.ts', 'v1');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    base = git(root, 'rev-parse', 'HEAD');
    write(root, 'jobs/oneshot-own/index.ts', 'v2');
    write(root, 'Dockerfile.oneshot-docker', 'v2');
    write(root, 'shared/lib.ts', 'v2');
    git(root, 'commit', '-qam', 'push');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ALL = ['oneshot-own', 'oneshot-docker', 'oneshot-dep', 'cron-explicit', 'cron-default', 'app-one'];
  // TARGET_BASES maps each target to its base; "" means it has none.
  const run = (opts: { base?: string; targets?: string[] }) => {
    const targets = opts.targets ?? ALL;
    const bases = Object.fromEntries(targets.map((t) => [t, opts.base ?? base]));
    return resultOf(
      runBashScript(filterScript, {
        cwd: root,
        pathPrepend: shimDir(),
        env: {
          TARGETS: JSON.stringify(targets),
          TARGET_BASES: JSON.stringify(bases),
          HEAD_SHA: git(root, 'rev-parse', 'HEAD'),
        },
      })
    );
  };

  it('skips only the one-shot touched solely through a shared dependency, and says so', () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.targets).toEqual(['oneshot-own', 'oneshot-docker', 'cron-explicit', 'cron-default', 'app-one']);
    expect(r.out).toContain('::notice title=Skipping one-shot jobs::');
    expect(r.out).toContain('oneshot-dep');
  });

  it.each([
    ['a one-shot whose own files changed', 'oneshot-own'],
    ['a one-shot whose root Dockerfile changed', 'oneshot-docker'],
    ['a cron job with an explicit job-type', 'cron-explicit'],
    ['a cron job with the default job-type', 'cron-default'],
    ['an app', 'app-one'],
  ])('keeps %s', (_label, target) => {
    const r = run({ targets: [target] });
    expect(r.targets).toEqual([target]);
    expect(r.out).not.toContain('Skipping one-shot jobs');
  });

  it('skips a dependency-only one-shot', () => {
    const r = run({ targets: ['oneshot-dep'] });
    expect(r.targets).toEqual([]);
    expect(r.out).toContain('::notice title=Skipping one-shot jobs::');
  });

  it('keeps every one-shot when no target has a base', () => {
    const r = run({ base: '' });
    expect(r.targets).toEqual(ALL);
    expect(r.out).not.toContain('Skipping one-shot jobs');
  });

  it('keeps a one-shot when git diff itself fails (fails toward building)', () => {
    const r = run({ base: 'deadbeef'.repeat(5), targets: ['oneshot-dep'] });
    expect(r.status).toBe(0);
    expect(r.targets).toEqual(['oneshot-dep']);
  });
});

/**
 * Each target is diffed from the commit it was last deployed at (BS#3564).
 *
 * `deploy-auto.yml` runs in a concurrency group, and GitHub keeps only one
 * pending run per group: a newer push cancels the older pending run. When
 * the base was `github.event.before`, the surviving run diffed only its own
 * push, so a target changed only by a dropped push was never built
 * (2026-10-20: `artist-search-alias-consumer` and `concerts-artist-resolver`).
 * Now each `deploy` leg records `refs/deployed/<target>`, and
 * `scripts/deploy-affected-targets.sh` diffs each target from its own ref.
 *
 * These tests run the real automatic arm of `Detect Build Target` -- the ref
 * fetch, the script with the real `turbo ls --affected`, and the filter loop
 * -- against a throwaway npm-workspaces repo. History: c0, then c1 (touches
 * jobs/x and jobs/y), then c2 (touches apps/backend), plus an orphan commit
 * standing in for history a force-push replaced.
 */
describe('per-target deployed refs pick the affected base (BS#3564)', () => {
  const step = findStep(loadWorkflow('deploy-base.yml').jobs.setup, 'Detect Build Target');
  const autoArm =
    sliceScript(step.run, 'echo "Detecting affected app targets', 'if [ "$TARGETS" = "[]" ]') +
    '\necho "RESULT=$TARGETS"\n';
  const yqDir = makeYqShim();
  type Commit = 'c0' | 'c1' | 'c2' | 'orphan';
  const sha = {} as Record<Commit, string>;
  let root: string;

  beforeAll(() => {
    root = initRepo('deploy-refs-');
    const workspaces = ['apps/*', 'jobs/*'];
    write(root, 'package.json', JSON.stringify({ name: 'r', private: true, packageManager: 'npm@10.0.0', workspaces }));
    write(
      root,
      'package-lock.json',
      JSON.stringify({ name: 'r', lockfileVersion: 3, requires: true, packages: { '': { name: 'r', workspaces } } })
    );
    write(root, 'turbo.json', JSON.stringify({ tasks: {} }));
    for (const ws of ['apps/backend', 'jobs/x', 'jobs/y']) {
      const name = path.basename(ws);
      write(root, `${ws}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
      write(root, `${ws}/index.ts`, 'v1');
      write(root, `Dockerfile.${name}`, 'v1');
    }
    // `Detect Build Target` calls the script by its repo-relative path.
    write(root, 'scripts/deploy-affected-targets.sh', affectedScript, 0o755);
    // `npx turbo` would try to download turbo; run the repo's copy instead.
    write(root, 'shims/npx', '#!/bin/sh\nexec "$@"\n', 0o755);
    const commit = (name: Commit, files: string[]) => {
      for (const f of files) {
        write(root, f, name);
      }
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', name);
      sha[name] = git(root, 'rev-parse', 'HEAD');
    };
    commit('c0', []);
    commit('c1', ['jobs/x/index.ts', 'jobs/y/index.ts']);
    commit('c2', ['apps/backend/index.ts']);
    git(root, 'checkout', '-q', '--orphan', 'side');
    commit('orphan', []);
    git(root, 'checkout', '-q', 'trunk');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Reset refs/deployed/* and the version tags, set the given ones, and run the step. */
  const run = (opts: {
    refs?: Record<string, Commit>;
    tags?: Record<string, Commit>;
    head?: Commit;
    before?: Commit | 'zero';
  }) => {
    for (const ref of git(root, 'for-each-ref', '--format=%(refname)', 'refs/deployed', 'refs/tags').split('\n')) {
      if (ref) {
        git(root, 'update-ref', '-d', ref);
      }
    }
    for (const [target, commit] of Object.entries(opts.refs ?? {})) {
      git(root, 'update-ref', `refs/deployed/${target}`, sha[commit]);
    }
    for (const [tag, commit] of Object.entries(opts.tags ?? {})) {
      git(root, 'tag', tag, sha[commit]);
    }
    const before = opts.before ?? 'c1';
    return resultOf(
      runBashScript(autoArm, {
        cwd: root,
        pathPrepend: `${path.join(root, 'shims')}:${yqDir()}:${turboBin}`,
        env: {
          HOME: root,
          TURBO_TELEMETRY_DISABLED: '1',
          EVENT_BEFORE: before === 'zero' ? '0'.repeat(40) : sha[before],
          HEAD_SHA: sha[opts.head ?? 'c2'],
        },
      })
    );
  };

  it('builds a target that only a dropped push changed', () => {
    // c1's run was dropped; the last deploy of every target was c0.
    const r = run({ refs: { backend: 'c0', x: 'c0', y: 'c0' } });
    expect(r.status).toBe(0);
    expect(r.targets).toEqual(['backend', 'x', 'y']);
    expect(r.out).toContain(`Affected base ${sha.c0} (source: refs/deployed/backend refs/deployed/x refs/deployed/y )`);
  });

  it.each([
    [
      'keeps a target whose deploy failed, and drops one whose ref advanced',
      { refs: { backend: 'c1', x: 'c1', y: 'c0' } },
      ['backend', 'y'],
      'source: refs/deployed/y',
    ],
    [
      'uses the newest version tag (by version, not text) when a ref is missing',
      { refs: { backend: 'c1', x: 'c1' }, tags: { 'y/v0.1.9': 'c1', 'y/v0.1.10': 'c0' } },
      ['backend', 'y'],
      'source: tag:y/v0.1.10',
    ],
    [
      'uses github.event.before when a target has no ref and no tag',
      { refs: { backend: 'c1', x: 'c1' } },
      ['backend'],
      'source: github.event.before',
    ],
    [
      'falls back to the tag when a ref has diverged from HEAD (force-push)',
      { refs: { backend: 'c1', x: 'orphan', y: 'c1' }, tags: { 'x/v0.1.0': 'c0' } },
      ['backend', 'x'],
      '::warning title=Deployed ref diverged::refs/deployed/x',
    ],
    [
      'builds a target with no usable base unscoped, and says so',
      { refs: { backend: 'c1', x: 'c1' }, before: 'zero' as const },
      ['backend', 'y'],
      '::warning title=Deploying unscoped targets::No usable base for y',
    ],
    [
      'skips targets deployed at or after HEAD (a re-run of an older run)',
      { refs: { backend: 'c2', x: 'c1', y: 'c2' }, head: 'c1' as const, before: 'c0' as const },
      [],
      '::notice title=Already deployed::Skipping backend x y',
    ],
  ] as const)('%s', (_label, opts, targets, log) => {
    const r = run(opts);
    expect(r.status).toBe(0);
    expect(r.targets).toEqual(targets);
    expect(r.out).toContain(log);
  });

  describe('wiring', () => {
    const deployJob = loadWorkflow('deploy-base.yml').jobs.deploy as unknown as {
      strategy: { matrix: { target: string } };
      steps: { name?: string; if?: string; env?: Record<string, string>; with?: { script?: string } }[];
      'continue-on-error'?: unknown;
    };

    it('passes the push range through env, never inline', () => {
      expect(step.env).toMatchObject({ EVENT_BEFORE: '${{ github.event.before }}', HEAD_SHA: '${{ github.sha }}' });
      expect(step.run).not.toContain('${{');
    });

    it('records the deployed commit as the last step of each deploy leg', () => {
      // Last, unconditional, and not continue-on-error: the ref moves only
      // when every earlier step of the leg succeeded, and a failure to move
      // it is loud rather than a silent rebuild on every later push.
      const last = deployJob.steps[deployJob.steps.length - 1] as Record<string, any>;
      expect(last.name).toBe('Record deployed commit');
      expect(last.if).toBeUndefined();
      expect(last['continue-on-error']).toBeUndefined();
      expect(last.env).toMatchObject({ VERSION: '${{ steps.determine_version.outputs.deploy_version }}' });
      expect(last.with.script).toContain('deployed/${TARGET}');
      expect(last.with.script).toContain('force: true');
    });

    it.each(['deploy-base.yml', 'deploy-auto.yml', 'deploy-manual.yml'])(
      'grants contents: write in %s, which pushing the ref needs on both sides of the call',
      (file) => {
        expect(loadWorkflow(file).permissions).toMatchObject({ contents: 'write' });
      }
    );

    it('drives the deploy matrix (and its crontab install) from the same target list', () => {
      // `Deploy Cron Job` runs per `deploy` matrix entry, so a job picked up
      // from a dropped push gets its crontab entry with no extra wiring.
      expect(deployJob.strategy.matrix.target).toBe('${{ fromJSON(needs.setup.outputs.targets) }}');
      expect(deployJob.steps.map((s) => s.name)).toContain('Deploy Cron Job');
    });
  });
});
