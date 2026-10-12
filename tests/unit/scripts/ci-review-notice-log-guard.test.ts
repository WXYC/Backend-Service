/**
 * Pin the two strings the integration job's review-notice log guard copies from elsewhere (BS#3109).
 *
 * The "Fail on review notice failures in the backend log" step in `test.yml` greps `/tmp/backend.log` for the prefix
 * `reportFailure` writes. Both strings are copies: if `reportFailure`'s message is reworded or the backend's log
 * redirect moves, the guard keeps passing (an absent file or an absent match is a pass) and stops guarding. This
 * spec fails first. Read as text, like its siblings in this directory.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf-8');
const service = fs.readFileSync(path.join(repoRoot, 'apps/backend/services/review-notices.service.ts'), 'utf-8');

const guardStep = (() => {
  const start = workflow.indexOf('- name: Fail on review notice failures in the backend log');
  expect(start).toBeGreaterThan(-1);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
})();

describe('review notice log guard in test.yml', () => {
  it('greps for the exact message `reportFailure` logs', () => {
    const logged = /console\.error\('([^']+)',\s*safe\)/.exec(service);
    expect(logged).not.toBeNull();
    const grepped = /grep\s+(?:-\S+\s+)*'([^']+)'/.exec(guardStep);
    expect(grepped).not.toBeNull();
    expect(grepped[1]).toBe(logged[1]);
  });

  it("reads the log file the backend's stdout is redirected to in 'Start services'", () => {
    const redirect = /node apps\/backend\/dist\/app\.js > (\S+) 2>&1 &/.exec(workflow);
    expect(redirect).not.toBeNull();
    const guarded = [...guardStep.matchAll(/\/tmp\/\S+\.log/g)].map((m) => m[0]);
    expect(guarded.length).toBeGreaterThan(0);
    for (const file of guarded) expect(file).toBe(redirect[1]);
  });
});
