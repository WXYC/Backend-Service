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
    // the whole matrix. station-signup-attempt-prune reads only its own package.json.
    //
    // The sibling used here has moved twice, both times because the job
    // standing in for "a normal cron job" was itself retired: flowsheet-etl
    // went `job-type: one-shot` in Phase 3 of the tubafrenzy decommission
    // (WXYC/wiki#88), then library-etl did the same in Phase 3.5
    // (WXYC/wiki#89). station-signup-attempt-prune is deliberately unrelated to the
    // decommission, so it is not a third one waiting to be retired.
    const otherJobPkg = path.join(repoRoot, 'jobs/station-signup-attempt-prune/package.json');
    const otherDefault = JSON.parse(fs.readFileSync(otherJobPkg, 'utf-8'))['cron-schedule'];
    const { stdout, status } = run('station-signup-attempt-prune', { BACKFILL_CRON_SCHEDULE: '*/15 * * * *' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(otherDefault);
  });

  // WXYC/wiki#89 Phase 3.5: the catalog write-authority flip moved librarians
  // to the dj-site edit UI, so tubafrenzy MySQL is no longer a catalog source
  // and the every-30-minutes MySQL -> Backend import has nothing left to read.
  // Going `one-shot` is what stops the deploy from re-registering the crontab
  // entry; removing the installed entry on the host is a separate manual step
  // (the deploy never deletes crontab lines, it only installs them).
  //
  // Pinned here rather than left implicit because the failure mode is silent:
  // a job that keeps its `cron-schedule` gets re-registered by the next
  // deploy of any target, quietly resurrecting a reader of a database that is
  // being switched off.
  it('library-etl is one-shot and carries no cron-schedule', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'jobs/library-etl/package.json'), 'utf-8'));
    expect(pkg['job-type']).toBe('one-shot');
    expect(pkg['cron-schedule']).toBeUndefined();
  });

  it('exits 1 when target package.json is missing', () => {
    const { stderr, status } = run('nonexistent-job', { BACKFILL_CRON_SCHEDULE: '' });
    expect(status).toBe(1);
    expect(stderr).toMatch(/Missing jobs\/nonexistent-job\/package\.json/);
  });

  // BS#1665: re-narrowed the override allowlist to drop
  // rotation-lml-identity-backfill (BS#1380 had added it). Sharing the
  // allowlist let a single BACKFILL_CRON_SCHEDULE env var snap both jobs to
  // the same schedule — the same simultaneous-double-fire failure mode
  // (LML#803) BS#1665 removed, by a different invisible route. Its slot is
  // now fixed and ignores the override.
  it('ignores BACKFILL_CRON_SCHEDULE for rotation-lml-identity-backfill (narrow override scope)', () => {
    const pkgPath = path.join(repoRoot, 'jobs/rotation-lml-identity-backfill/package.json');
    const ownDefault = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))['cron-schedule'];
    const { stdout, status } = run('rotation-lml-identity-backfill', {
      BACKFILL_CRON_SCHEDULE: '*/30 * * * *',
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(ownDefault);
  });
});
