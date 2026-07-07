/**
 * Shell-out gate for the Python job `jobs/rotation-release-id-pollution-check`
 * (BS#1522) — the first Python job in the fleet, so its logic can't ride the
 * TS unit suite directly. Both of its `--self-test` suites (the scoring engine
 * relocated from scripts/audit in #1522, and the job's alerting/provenance
 * pure functions) run here so a regression fails `npm run test:unit` the same
 * way a TS job's unit tests would.
 *
 * python3 availability is a HARD requirement, not a skip condition: it is
 * present on ubuntu-latest CI runners and org dev machines (macOS), and a
 * silent skip would let a scoring regression through the exact gate this test
 * provides. The Dockerfile's build-time `RUN ... --self-test` is the
 * independent second layer (deploy-base's image build fails too).
 */

import * as path from 'path';
import { execFileSync } from 'child_process';

const jobDir = path.resolve(__dirname, '../../../jobs/rotation-release-id-pollution-check');

interface ExecResult {
  stdout: string;
  status: number;
}

function runSelfTest(script: string): ExecResult {
  try {
    const stdout = execFileSync('python3', [path.join(jobDir, script), '--self-test'], {
      cwd: jobDir,
      stdio: 'pipe',
    }).toString();
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      stdout: [(err.stdout ?? Buffer.from('')).toString(), (err.stderr ?? Buffer.from('')).toString()].join('\n'),
      status: err.status ?? 1,
    };
  }
}

describe('jobs/rotation-release-id-pollution-check python self-tests', () => {
  it('python3 is available (hard requirement — see header comment)', () => {
    expect(() => execFileSync('python3', ['--version'], { stdio: 'pipe' })).not.toThrow();
  });

  it('pollution_engine.py --self-test passes', () => {
    const { stdout, status } = runSelfTest('pollution_engine.py');
    expect(stdout).not.toContain('FAIL');
    expect(status).toBe(0);
  });

  it('job.py --self-test passes', () => {
    const { stdout, status } = runSelfTest('job.py');
    expect(stdout).not.toContain('FAIL');
    expect(status).toBe(0);
  });
});
