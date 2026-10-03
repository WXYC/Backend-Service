import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `set-ec2-env-var.yml` can only write keys it lists by name. Every key must
 * appear in BOTH the resolve step's `env:` block (so the secret is read) and
 * the `case "$SECRET_NAME"` allowlist (so the value is forwarded). A key in
 * only one of the two fails at run time, not at review time.
 */
const WORKFLOW = readFileSync(join(__dirname, '../../../.github/workflows/set-ec2-env-var.yml'), 'utf8');

const ALLOWLISTED_KEYS = ['REVIEW_GATE_CUTOVER_DATE'] as const;

describe('set-ec2-env-var.yml allowlist', () => {
  it.each(ALLOWLISTED_KEYS)('reads %s from secrets in the resolve env block', (key) => {
    expect(WORKFLOW).toContain(`${key}: \${{ secrets.${key} }}`);
  });

  it.each(ALLOWLISTED_KEYS)('forwards %s through the SECRET_NAME case statement', (key) => {
    expect(WORKFLOW).toContain(`${key}) VALUE="$${key}" ;;`);
  });
});
