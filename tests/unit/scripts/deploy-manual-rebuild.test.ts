/**
 * Pin the `rebuild` switch on Manual Build & Deploy (BS#2908, slice L0 of BS#2907).
 *
 * `deploy-manual.yml` used to send `version: ... || 'latest'`, which resolves to
 * an existing tag and never builds. `rebuild=true` sends an empty version so
 * `deploy-base.yml`'s `handle-git-tags` bumps, tags and builds at `github.sha`.
 *
 * The mapping must read the typed `inputs` context. `github.event.inputs.rebuild`
 * is the string `'false'`, which is truthy, so `!'false'` would turn every
 * ordinary dispatch (rollbacks included) into a rebuild of main.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(__dirname, '..', '..', '..');
const workflows = join(repoRoot, '.github', 'workflows');
const manual = readFileSync(join(workflows, 'deploy-manual.yml'), 'utf8');
const base = readFileSync(join(workflows, 'deploy-base.yml'), 'utf8');

/**
 * Run a workflow `run:` step the way GitHub does (bash, `-eo pipefail`), with
 * the step's `env:` keys set from the given `${{ ... }}` expressions. The
 * scripts must take dispatch inputs only through `env:`; a `${{ inputs.* }}`
 * left in the script body is pasted into the shell before it runs (script
 * injection), and would also make bash fail here on `${{`.
 */
type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { if?: unknown; needs?: unknown; permissions?: unknown; steps: Step[] };
const runScript = (step: Step & { run: string }, expressions: Record<string, string>, cwd: string) => {
  const values = Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, expr]) => {
      const value = Object.entries(expressions).find(([e]) => e === expr)?.[1];
      if (value === undefined) throw new Error(`unexpected env expression ${key}: ${expr}`);
      return [key, value];
    })
  );
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
    cwd,
    env: { PATH: process.env.PATH, ...values },
    encoding: 'utf8',
  });
};
const findStep = (job: Job, name?: string) => {
  const found = name ? job.steps.find((s) => s.name === name) : job.steps.find((s) => s.run);
  if (!found?.run) throw new Error(`step "${name ?? '(first run step)'}" not found`);
  return found as Step & { run: string };
};

const manualDoc = parseYaml(manual) as {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  jobs: Record<string, Job>;
};

describe('deploy-manual.yml rebuild switch', () => {
  it('declares a boolean rebuild input defaulting to false', () => {
    expect(manualDoc.on.workflow_dispatch.inputs.rebuild).toMatchObject({ type: 'boolean', default: false });
  });

  it('maps rebuild to an empty version through the typed inputs context', () => {
    expect(manual).toContain("version: ${{ !inputs.rebuild && (inputs.version || 'latest') || '' }}");
    expect(manual).not.toContain('github.event.inputs.rebuild');
  });

  const validateRebuild = manualDoc.jobs['validate-rebuild'];

  it('always runs the validation job, with no token scope', () => {
    expect(validateRebuild.if).toBeUndefined();
    expect(validateRebuild.permissions).toEqual({});
  });

  // The job always runs (a skipped ancestor can silently skip the called workflow's
  // jobs, actions/runner#2205), so the script itself gates on REBUILD.
  it.each<[string, string, string, string, boolean]>([
    ['a rebuild with no version, from main', 'true', '', 'refs/heads/main', true],
    ['a rebuild with an explicit version', 'true', 'v1.2.3', 'refs/heads/main', false],
    ['a rebuild from a ref other than main', 'true', '', 'refs/heads/feature/x', false],
    ['a rebuild from a tag ref', 'true', '', 'refs/tags/backend/v1.2.3', false],
    ['an ordinary dispatch from main', 'false', '', 'refs/heads/main', true],
    ['a rollback to a version, from a branch', 'false', 'v1.2.3', 'refs/heads/feature/x', true],
    ['a rollback to a version, from a tag ref', 'false', 'v1.2.3', 'refs/tags/backend/v1.2.3', true],
  ])('validate-rebuild with %s', (_label, rebuild, version, ref, ok) => {
    const r = runScript(
      findStep(validateRebuild),
      { '${{ inputs.rebuild }}': rebuild, '${{ inputs.version }}': version, '${{ github.ref }}': ref },
      repoRoot
    );
    expect(r.status === 0).toBe(ok);
  });

  it('gates the call job on the validation job with no status-function condition', () => {
    const callJob = manualDoc.jobs['trigger-build-and-deploy'];
    expect(callJob.needs).toBe('validate-rebuild');
    expect(callJob.if).toBeUndefined();
    const call = manual.slice(manual.indexOf('trigger-build-and-deploy:'));
    expect(call).not.toMatch(/cancelled\(\)|failure\(\)|success\(\)|always\(\)/);
  });
});

/**
 * `validate_inputs` runs against a fixture tree rather than the repo, so the
 * cases don't drift as targets come and go: two buildable apps, a buildable
 * job, a job whose root Dockerfile was removed (like a retired one-shot), and
 * a subdirectory that is not a target.
 */
const validateInputs = (parseYaml(base) as { jobs: { validate_inputs: Job } }).jobs.validate_inputs;
let fixture: string;
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'deploy-validate-'));
  for (const dir of ['apps/backend/src', 'apps/auth', 'jobs/flowsheet-etl', 'jobs/retired-job']) {
    mkdirSync(join(fixture, dir), { recursive: true });
  }
  for (const target of ['backend', 'auth', 'flowsheet-etl']) {
    writeFileSync(join(fixture, `Dockerfile.${target}`), 'FROM scratch\n');
  }
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const runValidate = (name: string, target: string, version: string) =>
  runScript(
    findStep(validateInputs, name),
    { '${{ inputs.target }}': target, '${{ inputs.version }}': version },
    fixture
  );

describe('deploy-base.yml per-target validation', () => {
  it.each(['Validate Build Target', 'Validate Version Input Format'])(
    '%s reads the inputs through env, not by interpolating them into the script',
    (name) => {
      const { env = {}, run } = findStep(validateInputs, name);
      expect(run).not.toContain('${{');
      expect(Object.values(env)).toContain('${{ inputs.target }}');
    }
  );

  // 'latest' is what an ordinary dispatch sends; '' is what rebuild=true sends.
  it.each<[string, string, string, boolean]>([
    ['one existing target', 'backend', 'latest', true],
    ['several existing targets, one per line', 'backend\nauth\n', 'latest', true],
    ['an existing app and an existing job', 'backend\nflowsheet-etl', 'latest', true],
    ['a target that does not exist', 'nope', 'latest', false],
    ['one missing target among existing ones', 'backend\nnope', 'latest', false],
    ['only newlines', '\n\n', 'latest', false],
    ['only whitespace', ' \n\t', 'latest', false],
    ['shell metacharacters', 'backend" ; exit 0 ; echo "', 'latest', false],
    ['a repeated target', 'backend\nauth\nbackend', 'latest', false],
    ['a subdirectory of a target', 'backend/src', 'latest', false],
    ['the parent directory', '..', 'latest', false],
    ['a target with no Dockerfile, on an ordinary dispatch', 'retired-job', 'latest', true],
    ['several buildable targets, on a rebuild', 'backend\nflowsheet-etl', '', true],
    ['a target with no Dockerfile, on a rebuild', 'retired-job', '', false],
    ['one unbuildable target among buildable ones, on a rebuild', 'backend\nretired-job', '', false],
  ])('Validate Build Target with %s', (_label, target, version, ok) => {
    expect(runValidate('Validate Build Target', target, version).status === 0).toBe(ok);
  });

  // With version=latest there is no tag to look up; a blank-only target is already
  // refused by Validate Build Target earlier in the same job.
  it.each<[string, string, boolean]>([
    ['one target', 'backend', true],
    ['several targets, one per line', 'backend\nauth\n', true],
  ])('Validate Version Input Format (version=latest) with %s', (_label, target, ok) => {
    expect(runValidate('Validate Version Input Format', target, 'latest').status === 0).toBe(ok);
  });

  it('Validate Version Input Format does not execute a target as shell', () => {
    // No tag `backend" ; exit 0 ; echo "/v0.0.0-nope` exists, so the step must fail
    // rather than reach an injected `exit 0`.
    expect(runValidate('Validate Version Input Format', 'backend" ; exit 0 ; echo "', 'v0.0.0-nope').status).not.toBe(
      0
    );
  });

  it('Validate Version Input Format still rejects a malformed version', () => {
    expect(runValidate('Validate Version Input Format', 'backend', '1.2').status).not.toBe(0);
  });
});
