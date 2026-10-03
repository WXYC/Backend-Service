import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

/**
 * `set-ec2-env-var.yml` can only write keys it lists by name. Every key must
 * appear in BOTH the resolve step's `env:` block (so the secret is read) and
 * the `case "$SECRET_NAME"` allowlist (so the value is forwarded). A key in
 * only one of the two fails at run time ("Unsupported secret_name"), not at
 * review time.
 *
 * The full-set equality check below parses the workflow with the `yaml`
 * package (same pattern as
 * `tests/unit/apps/backend/app-yaml-unrecoverable-dependents.test.ts`) for
 * the env-block side, and regexes the "Resolve secret value" step's `run:`
 * shell script for the case-statement side — the case statement lives
 * inside a bash heredoc, which YAML parses as an opaque string, so there is
 * no YAML-native way to read it. Asserting the two key sets are EQUAL, not
 * just that one named key is present in both, means a later PR that adds a
 * key to only one side fails here instead of surfacing as a live
 * `gh workflow run` failure on the day someone needs that key.
 */
const repoRoot = join(__dirname, '../../..');
const workflowPath = join(repoRoot, '.github/workflows/set-ec2-env-var.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const workflowDoc = parseYaml(workflowSource) as {
  jobs: { upsert: { steps: Array<{ name?: string; env?: Record<string, unknown>; run?: string }> } };
};

const resolveStep = workflowDoc.jobs.upsert.steps.find((step) => step.name === 'Resolve secret value');
if (!resolveStep) {
  throw new Error('"Resolve secret value" step not found in set-ec2-env-var.yml');
}

const envBlockKeys = Object.keys(resolveStep.env ?? {}).sort();

const caseBlockMatch = String(resolveStep.run ?? '').match(/case "\$SECRET_NAME" in([\s\S]*?)esac/);
if (!caseBlockMatch) {
  throw new Error('case "$SECRET_NAME" ... esac block not found in the resolve step\'s run script');
}
const caseArmKeys = [...caseBlockMatch[1].matchAll(/^\s*([A-Z0-9_]+)\)/gm)].map((match) => match[1]).sort();

// Keys added individually, kept as targeted regressions alongside the
// full-set check below.
const ALLOWLISTED_KEYS = ['REVIEW_GATE_CUTOVER_DATE', 'CORS_PREVIEW_ORIGINS'] as const;

describe('set-ec2-env-var.yml allowlist', () => {
  it.each(ALLOWLISTED_KEYS)('reads %s from secrets in the resolve env block', (key) => {
    expect(workflowSource).toContain(`${key}: \${{ secrets.${key} }}`);
  });

  it.each(ALLOWLISTED_KEYS)('forwards %s through the SECRET_NAME case statement', (key) => {
    expect(workflowSource).toContain(`${key}) VALUE="$${key}" ;;`);
  });

  it('lists exactly the same keys in the resolve env block and the case statement', () => {
    expect(envBlockKeys).toEqual(caseArmKeys);
  });
});
