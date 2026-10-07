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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { findStep, runBashScript, stepEnvFrom, type Job, type Step } from '../../utils/workflow-step';

const repoRoot = join(__dirname, '..', '..', '..');
const workflows = join(repoRoot, '.github', 'workflows');
const manual = readFileSync(join(workflows, 'deploy-manual.yml'), 'utf8');
const base = readFileSync(join(workflows, 'deploy-base.yml'), 'utf8');

const runScript = (
  step: Step & { run: string },
  expressions: Record<string, string>,
  cwd: string,
  extraEnv: Record<string, string> = {}
) => runBashScript(step.run, { env: { ...stepEnvFrom(step, expressions), ...extraEnv }, cwd });

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
    expect(manual).toContain('target: ${{ inputs.target }}');
    expect(manual).not.toContain('github.event.inputs');
  });

  const validateRebuild = manualDoc.jobs['validate-rebuild'];

  it('always runs the validation job, with no token scope', () => {
    expect(validateRebuild.if).toBeUndefined();
    expect(validateRebuild.permissions).toEqual({});
  });

  // The job always runs (a skipped ancestor can silently skip the called workflow's
  // jobs, actions/runner#2205), so the script itself gates on REBUILD.
  it.each<[string, string, string, string, string, boolean]>([
    ['a rebuild with no version, from main', 'true', 'backend', '', 'refs/heads/main', true],
    ['a rebuild of several targets', 'true', 'backend\nauth', '', 'refs/heads/main', true],
    ['a rebuild with an exactly empty target', 'true', '', '', 'refs/heads/main', false],
    ['a rebuild with a blank-only target', 'true', ' \n\t\n', '', 'refs/heads/main', false],
    ['a rebuild with an explicit version', 'true', 'backend', 'v1.2.3', 'refs/heads/main', false],
    ['a rebuild from a ref other than main', 'true', 'backend', '', 'refs/heads/feature/x', false],
    ['a rebuild from a tag ref', 'true', 'backend', '', 'refs/tags/backend/v1.2.3', false],
    ['an ordinary dispatch from main', 'false', 'backend', '', 'refs/heads/main', true],
    ['a rollback to a version, from a branch', 'false', 'backend', 'v1.2.3', 'refs/heads/feature/x', true],
    ['a rollback to a version, from a tag ref', 'false', 'backend', 'v1.2.3', 'refs/tags/backend/v1.2.3', true],
  ])('validate-rebuild with %s', (_label, rebuild, target, version, ref, ok) => {
    const r = runScript(
      findStep(validateRebuild),
      {
        '${{ inputs.rebuild }}': rebuild,
        '${{ inputs.target }}': target,
        '${{ inputs.version }}': version,
        '${{ github.ref }}': ref,
      },
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

  // An explicit version names a tag per target, so no target means nothing to check.
  // The automatic path (deploy-auto.yml) sends an empty target AND an empty version,
  // which skips this step entirely (`if: inputs.version != ''`).
  it.each<[string, string, string, boolean]>([
    ['an empty target and an explicit version', '', 'v1.2.3', false],
    ['a blank-only target and an explicit version', ' \n\t', 'v1.2.3', false],
    ['an empty target and version=latest', '', 'latest', false],
  ])('Validate Version Input Format with %s', (_label, target, version, ok) => {
    expect(runValidate('Validate Version Input Format', target, version).status === 0).toBe(ok);
  });

  it('skips Validate Version Input Format and Validate Build Target on the automatic path (empty target, empty version)', () => {
    const steps = validateInputs.steps as (Step & { if?: string })[];
    expect(steps.find((s) => s.name === 'Validate Version Input Format')?.if).toBe("inputs.version != ''");
    expect(steps.find((s) => s.name === 'Validate Build Target')?.if).toBe("inputs.target != ''");
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

describe('dispatch inputs reach run: scripts only through env:', () => {
  const stepsOf = (doc: string) =>
    Object.entries((parseYaml(doc) as { jobs: Record<string, Job> }).jobs).flatMap(([job, { steps = [] }]) =>
      steps.filter((s) => s.run).map((s) => [`${job} / ${s.name ?? '(unnamed)'}`, s.run] as const)
    );

  it.each([
    ...stepsOf(base).map((s) => ['deploy-base.yml', ...s]),
    ...stepsOf(manual).map((s) => ['deploy-manual.yml', ...s]),
  ])('%s: %s has no inputs interpolation in its script', (_file, _step, run) => {
    expect(run).not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
  });

  // Behaviour pin: 'latest' is an ordinary dispatch, a tag is a pinned dispatch, '' is rebuild/automatic.
  it.each<[string, string, string]>([
    ['latest', 'v9.8.7', 'v9.8.7'],
    ['v1.2.3', 'v9.8.7', 'v1.2.3'],
    ['', 'v9.8.7', 'v9.8.8'],
  ])('Determine Deploy Version with version %j yields %s', (version, _latest, expected) => {
    const job = Object.values((parseYaml(base) as { jobs: Record<string, Job> }).jobs).find((j) =>
      j.steps?.some((st) => st.name === 'Determine Deploy Version')
    );
    if (!job) throw new Error('job with Determine Deploy Version not found');
    const step = findStep(job, 'Determine Deploy Version');
    const out = join(fixture, `out-${version || 'empty'}`);
    const run = step.run
      .replace(/\$\{\{\s*steps\.latest_tag\.outputs\.latest_tag\s*\}\}/g, 'backend/v9.8.7')
      .replace(/\$\{\{\s*steps\.latest_tag\.outputs\.is_initial\s*\}\}/g, 'false')
      .replace(/\$\{\{\s*steps\.bump_version\.outputs\.next_version\s*\}\}/g, '9.8.8');
    const result = runScript(
      { ...step, run },
      { '${{ inputs.target }}': '', '${{ inputs.version }}': version },
      fixture,
      { GITHUB_OUTPUT: out }
    );
    expect(result.status).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe(`deploy_version=${expected}`);
  });
});
