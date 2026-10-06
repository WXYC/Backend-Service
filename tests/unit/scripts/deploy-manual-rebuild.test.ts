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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(__dirname, '..', '..', '..');
const workflows = join(repoRoot, '.github', 'workflows');
const manual = readFileSync(join(workflows, 'deploy-manual.yml'), 'utf8');
const base = readFileSync(join(workflows, 'deploy-base.yml'), 'utf8');

describe('deploy-manual.yml rebuild switch', () => {
  it('declares a boolean rebuild input defaulting to false', () => {
    const doc = parseYaml(manual) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } };
    expect(doc.on.workflow_dispatch.inputs.rebuild).toMatchObject({ type: 'boolean', default: false });
  });

  it('maps rebuild to an empty version through the typed inputs context', () => {
    expect(manual).toContain("version: ${{ !inputs.rebuild && (inputs.version || 'latest') || '' }}");
    expect(manual).not.toContain('github.event.inputs.rebuild');
  });

  it.each([
    ['an explicit version', /-n "\$VERSION_INPUT"/],
    ['a ref other than main', /"\$REF" != "refs\/heads\/main"/],
  ])('refuses a rebuild with %s', (_label, guard) => {
    const validate = manual.slice(manual.indexOf('validate-rebuild:'), manual.indexOf('trigger-build-and-deploy:'));
    expect(validate).toContain('if: inputs.rebuild');
    expect(validate).toMatch(guard);
    expect(validate).toContain('exit 1');
  });

  it('grants the validation job no token scope', () => {
    const doc = parseYaml(manual) as { jobs: Record<string, { permissions?: unknown }> };
    expect(doc.jobs['validate-rebuild'].permissions).toEqual({});
  });

  it('gates the call job on the validation job without being skipped by it', () => {
    const call = manual.slice(manual.indexOf('trigger-build-and-deploy:'));
    expect(call).toContain('needs: validate-rebuild');
    expect(call).toContain('!cancelled() && !failure()');
  });
});

/**
 * Run the two `validate_inputs` steps the way GitHub runs a `run:` step (bash,
 * `-eo pipefail`) from the repo root, with the step's `env:` keys set to the
 * dispatch inputs. The scripts must take the inputs only through `env:`; a
 * `${{ inputs.* }}` left in the script body is pasted into the shell before it
 * runs (script injection), and would also make bash fail here on `${{`.
 */
type Step = { name?: string; env?: Record<string, string>; run?: string };
const baseDoc = parseYaml(base) as { jobs: { validate_inputs: { steps: Step[] } } };
const step = (name: string) => {
  const found = baseDoc.jobs.validate_inputs.steps.find((s) => s.name === name);
  if (!found?.run) throw new Error(`step "${name}" not found in deploy-base.yml validate_inputs`);
  return found as Step & { run: string };
};
const runStep = (name: string, inputs: { target: string; version?: string }) => {
  const { env = {}, run } = step(name);
  const values = Object.fromEntries(
    Object.entries(env).map(([key, expr]) => {
      if (expr === '${{ inputs.target }}') return [key, inputs.target];
      if (expr === '${{ inputs.version }}') return [key, inputs.version ?? ''];
      throw new Error(`unexpected env expression ${key}: ${expr}`);
    })
  );
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, ...values },
    encoding: 'utf8',
  });
};

describe('deploy-base.yml per-target validation', () => {
  it.each(['Validate Build Target', 'Validate Version Input Format'])(
    '%s reads the inputs through env, not by interpolating them into the script',
    (name) => {
      const { env = {}, run } = step(name);
      expect(run).not.toContain('${{');
      expect(Object.values(env)).toContain('${{ inputs.target }}');
    }
  );

  it.each<[string, string, boolean]>([
    ['one existing target', 'backend', true],
    ['several existing targets, one per line', 'backend\nauth\n', true],
    ['an existing app and an existing job', 'backend\nflowsheet-etl', true],
    ['a target that does not exist', 'nope', false],
    ['one missing target among existing ones', 'backend\nnope', false],
    ['only newlines', '\n\n', false],
    ['only whitespace', ' \n\t', false],
    ['shell metacharacters', 'backend" ; exit 0 ; echo "', false],
  ])('Validate Build Target with %s', (_label, target, ok) => {
    expect(runStep('Validate Build Target', { target }).status === 0).toBe(ok);
  });

  // With version=latest there is no tag to look up, so this step only has the
  // zero-target guard; directory existence is the step above's job.
  it.each<[string, string, boolean]>([
    ['one target', 'backend', true],
    ['several targets, one per line', 'backend\nauth\n', true],
    ['only newlines', '\n\n', false],
  ])('Validate Version Input Format (version=latest) with %s', (_label, target, ok) => {
    expect(runStep('Validate Version Input Format', { target, version: 'latest' }).status === 0).toBe(ok);
  });

  it('Validate Version Input Format does not execute a target as shell', () => {
    // No tag `backend" ; exit 0 ; echo "/v0.0.0-nope` exists, so the step must fail
    // rather than reach an injected `exit 0`.
    const r = runStep('Validate Version Input Format', {
      target: 'backend" ; exit 0 ; echo "',
      version: 'v0.0.0-nope',
    });
    expect(r.status).not.toBe(0);
  });

  it('Validate Version Input Format still rejects a malformed version', () => {
    expect(runStep('Validate Version Input Format', { target: 'backend', version: '1.2' }).status).not.toBe(0);
  });
});
