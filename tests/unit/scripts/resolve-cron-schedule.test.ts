/**
 * Tests for `scripts/resolve-cron-schedule.sh` (BS#914 / H7).
 *
 * The script is the only place that resolves a job's cron schedule. The
 * deploy workflow calls it from `Get Deploy Vars`. These tests pin three
 * properties:
 *
 *   1. Without an env override, the script returns the package.json value
 *      verbatim — same behavior the prior `yq -r '.["cron-schedule"]'`
 *      one-liner gave the workflow.
 *   2. With `BACKFILL_CRON_SCHEDULE` set in env and target =
 *      `flowsheet-metadata-backfill`, the script returns the override.
 *   3. With `BACKFILL_CRON_SCHEDULE` set in env but a *different* target
 *      (e.g., `flowsheet-etl`), the script returns the package.json value —
 *      the override scope is narrow on purpose so a stale env var can't
 *      fan out across the deploy matrix.
 *   4. A missing target exits non-zero (deploy fails fast).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts/resolve-cron-schedule.sh');

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(target: string, env: NodeJS.ProcessEnv = {}): ExecResult {
  try {
    const stdout = execFileSync('bash', [scriptPath, target], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    }).toString();
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { status: number; stdout?: Buffer; stderr?: Buffer };
    return {
      stdout: (err.stdout ?? Buffer.from('')).toString(),
      stderr: (err.stderr ?? Buffer.from('')).toString(),
      status: err.status ?? 1,
    };
  }
}

describe('scripts/resolve-cron-schedule.sh', () => {
  // Snapshot the package.json default so the test stays correct if someone
  // legitimately bumps the default cadence — the contract is "return the
  // package.json value when no override", not a hard-coded string.
  const pkgPath = path.join(repoRoot, 'jobs/flowsheet-metadata-backfill/package.json');
  const packageDefault = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))['cron-schedule'];

  it('returns package.json value when no override env var is set', () => {
    const { stdout, status } = run('flowsheet-metadata-backfill', { BACKFILL_CRON_SCHEDULE: '' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(packageDefault);
  });

  it('returns override when BACKFILL_CRON_SCHEDULE is set and target matches', () => {
    const { stdout, status } = run('flowsheet-metadata-backfill', {
      BACKFILL_CRON_SCHEDULE: '*/15 * * * *',
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('*/15 * * * *');
  });

  it('ignores BACKFILL_CRON_SCHEDULE for other jobs (narrow override scope)', () => {
    // Override scope is narrow so a stale env var can't fan out across
    // the whole matrix. flowsheet-etl reads only its own package.json.
    const otherJobPkg = path.join(repoRoot, 'jobs/flowsheet-etl/package.json');
    const otherDefault = JSON.parse(fs.readFileSync(otherJobPkg, 'utf-8'))['cron-schedule'];
    const { stdout, status } = run('flowsheet-etl', { BACKFILL_CRON_SCHEDULE: '*/15 * * * *' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(otherDefault);
  });

  it('exits 1 when target package.json is missing', () => {
    const { stderr, status } = run('nonexistent-job', { BACKFILL_CRON_SCHEDULE: '' });
    expect(status).toBe(1);
    expect(stderr).toMatch(/Missing jobs\/nonexistent-job\/package\.json/);
  });

  // BS#1380: extend the override allowlist to include rotation-lml-identity-backfill.
  // Same operational story as flowsheet-metadata-backfill — both are LML-bounded
  // drift-repair crons whose cadence ops occasionally tightens. The allowlist
  // stays narrow and explicit.
  it('returns override when BACKFILL_CRON_SCHEDULE is set and target = rotation-lml-identity-backfill', () => {
    const { stdout, status } = run('rotation-lml-identity-backfill', {
      BACKFILL_CRON_SCHEDULE: '*/30 * * * *',
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('*/30 * * * *');
  });
});
