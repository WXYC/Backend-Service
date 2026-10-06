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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflows = join(__dirname, '..', '..', '..', '.github', 'workflows');
const manual = readFileSync(join(workflows, 'deploy-manual.yml'), 'utf8');
const base = readFileSync(join(workflows, 'deploy-base.yml'), 'utf8');

describe('deploy-manual.yml rebuild switch', () => {
  it('declares a boolean rebuild input defaulting to false', () => {
    expect(manual).toMatch(/rebuild:\n(?:\s+.*\n)*?\s+type: boolean\n\s+default: false/);
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

  it('gates the call job on the validation job without being skipped by it', () => {
    const call = manual.slice(manual.indexOf('trigger-build-and-deploy:'));
    expect(call).toContain('needs: validate-rebuild');
    expect(call).toContain('!cancelled() && !failure()');
  });
});

describe('deploy-base.yml per-target validation', () => {
  const step = (name: string) => {
    const start = base.indexOf(`- name: ${name}`);
    return base.slice(
      start,
      base.indexOf('\n      - name:', start + 1) > 0 ? base.indexOf('\n      - name:', start + 1) : undefined
    );
  };

  it.each(['Validate Build Target', 'Validate Version Input Format'])(
    '%s checks every newline-separated target',
    (name) => {
      const body = step(name);
      expect(body).toContain('while IFS= read -r TARGET_INPUT');
      expect(body).toContain('<<< "${{ inputs.target }}"');
    }
  );
});
