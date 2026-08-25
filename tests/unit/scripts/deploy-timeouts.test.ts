/**
 * Cap every job in `deploy-base.yml` with an explicit `timeout-minutes`
 * (BS#2266).
 *
 * # The failure this guards against
 *
 * A job with no `timeout-minutes` inherits GitHub's 360-minute default.
 * That is a fine default for a single job and a bad one here: `setup`
 * feeds a matrix into `handle-git-tags`, `build` and `deploy`, so one
 * push fans out to three jobs per target. Both `build` and `deploy` carry
 * `fail-fast: false`, which is correct (see the comment on the `deploy`
 * matrix) and also means a stage-wide stall is not cancelled by a sibling
 * failing.
 *
 * A hang mode that hits a whole stage -- an `appleboy/ssh-action` step
 * waiting on a wedged EC2 host, an ECR pull stalling -- therefore holds
 * every job in that stage at 360 minutes until GitHub reaps them. The
 * `deploy` and `reclaim-disk` jobs SSH into the shared prod host, which
 * has wedged before on disk pressure (2026-07-27; see the "Host disk
 * reclamation" section of `docs/deploy.md`). A wedged host produces a
 * stall, not an error.
 *
 * # This is insurance. No hang has been observed.
 *
 * Deliberately recorded so the next reader does not inherit a scary story
 * that the data does not support. Measured 2026-08-25 over 32
 * `deploy-auto.yml` runs (2026-08-11 to 2026-08-25), 1,512 samples each
 * for the three matrix jobs, `completed_at - started_at` per job:
 *
 *   job                  n    p50    p99    p100
 *   build             1512   0.63   4.03   17.82
 *   deploy            1512   0.20   3.28    4.27
 *   reclaim-disk        31   0.12   0.90    1.25
 *   migrate             31   0.98   1.20    1.20
 *   setup               32   0.80   0.92    1.08
 *   handle-git-tags   1512   0.25   0.37    0.63
 *   validate_inputs     32   0.17   0.20    0.38
 *   ecr-refresh-cron    32   0.10   0.13    0.13
 *
 * Nothing is close to 360. Run 32047919627, which reads as 177 minutes of
 * wall clock, was 172 minutes *queued* behind the `concurrency` group and
 * 4.5 minutes running -- queue time is not billed and is not capped by
 * `timeout-minutes`. It is not evidence for this guard.
 *
 * # Why the caps are loose, and why that is the point
 *
 * The hazard runs in the other direction. `deploy` runs
 * `docker stop` -> `docker rm` -> `docker run` on the prod host; a cap
 * that fires between stop and run leaves the service DOWN. `migrate`
 * applies schema migrations against prod. For those two, a timeout that
 * fires on a slow-but-healthy run is strictly worse than the slow run.
 * So every cap here sits at least `MIN_HEADROOM_MULTIPLE` above the
 * measured p100, and the two prod-mutating jobs get
 * `PROD_MUTATING_HEADROOM_MULTIPLE`.
 *
 * `build`'s p100 of 17.82 is not a lone outlier -- three of 1,512 samples
 * exceeded 10 minutes, all of them successful ETL-image builds that
 * missed the registry buildcache. A 30-minute cap would sit 1.7x above a
 * duration observed three times in two weeks, which is exactly the kind
 * of number that eventually fires on a healthy run. Hence 75.
 *
 * Cutting 360 to 75 still removes 79% of the exposure on the widest job,
 * and the short jobs drop by 96%.
 *
 * # Why this file is a `readFileSync` test, and what that costs
 *
 * It reads workflow YAML as text, so Jest's dependency graph has no edge
 * from `deploy-base.yml` to this spec; the job running it has to be
 * triggered by a change to the files it reads. `detect-changes`' `src`
 * filter in `test.yml` globs `.github/workflows/**`, which is what makes
 * that hold -- `ci-node-modules-cache.test.ts` asserts that glob directly,
 * so it is not re-asserted here.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDir = path.join(repoRoot, '.github/workflows');
const deployBase = fs.readFileSync(path.join(workflowDir, 'deploy-base.yml'), 'utf-8');

/** GitHub's implicit per-job cap when `timeout-minutes` is unset. */
const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360;

/**
 * Every top-level job in `deploy-base.yml`, in file order.
 *
 * Pinned exactly, not as a floor. A floor cannot catch a job dropping OUT
 * of the checked set -- a rename, a re-indent -- which would silently
 * exempt it from every assertion below while they all kept passing.
 */
const EXPECTED_JOBS = [
  'validate_inputs',
  'setup',
  'handle-git-tags',
  'build',
  'reclaim-disk',
  'ecr-refresh-cron',
  'migrate',
  'deploy',
] as const;

/**
 * p100 job duration in minutes, measured 2026-08-25 across 32
 * `deploy-auto.yml` runs (see the header). These are the floors the caps
 * are derived from; re-measure before lowering any cap.
 */
const MEASURED_P100_MINUTES: Record<(typeof EXPECTED_JOBS)[number], number> = {
  validate_inputs: 0.38,
  setup: 1.08,
  'handle-git-tags': 0.63,
  build: 17.82,
  'reclaim-disk': 1.25,
  'ecr-refresh-cron': 0.13,
  migrate: 1.2,
  deploy: 4.27,
};

/** Minimum ratio of cap to measured p100, per the ticket's acceptance criteria. */
const MIN_HEADROOM_MULTIPLE = 4;

/**
 * Jobs that mutate prod state and can therefore leave the station broken
 * if killed mid-flight: `deploy` does `docker stop`/`docker rm`/
 * `docker run` over SSH, `migrate` applies schema migrations. They get
 * more headroom than the acceptance criteria's 4x floor.
 */
const PROD_MUTATING_JOBS = ['migrate', 'deploy'] as const;
const PROD_MUTATING_HEADROOM_MULTIPLE = 6;

/**
 * Loosest cap this file will accept. Not a correctness bound -- it exists
 * so "raise the cap" can never quietly walk back to the 360-minute
 * default this ticket is about.
 */
const MAX_CAP_MINUTES = 90;

/** Drop comment-only lines: every check here must read YAML, not the prose above it. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The lines of `deploy-base.yml` below the top-level `jobs:` key, comments stripped. */
function jobsSection(): string[] {
  const lines = withoutComments(deployBase).split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) throw new Error("no top-level 'jobs:' key in deploy-base.yml");
  return lines.slice(start + 1);
}

/**
 * Every top-level job name, in file order. Jobs are the only keys at
 * exactly two spaces of indent inside the `jobs:` block, so anchoring on
 * that indent keeps `on:`/`permissions:` (which also have two-space
 * children) out of the result.
 */
function jobNames(): string[] {
  return jobsSection()
    .map((l) => l.match(/^ {2}([A-Za-z_][\w-]*):\s*$/)?.[1])
    .filter((n): n is string => n !== undefined);
}

/** The body of one top-level job, comments stripped, original indentation kept. */
function jobBody(name: string): string {
  const lines = jobsSection();
  const start = lines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l));
  if (start === -1) throw new Error(`job '${name}' not found in deploy-base.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

/**
 * A job's own `timeout-minutes`, or undefined when unset.
 *
 * Anchored at exactly four spaces so a step-level `timeout-minutes` (six
 * spaces or deeper, as `test.yml` uses) can never be mistaken for the
 * job-level cap. A step cap bounds one step; the job still runs to 360.
 */
function jobTimeout(name: string): number | undefined {
  const m = jobBody(name).match(/^ {4}timeout-minutes:[ \t]*(\d+)\s*$/m);
  return m ? Number(m[1]) : undefined;
}

describe('every deploy-base.yml job carries an explicit timeout (BS#2266)', () => {
  it('finds every job, and reads a job-level cap rather than a step-level one', () => {
    // If the parser silently matches nothing (or stops matching a job that
    // was renamed or re-indented), every assertion below passes vacuously.
    expect(jobNames()).toEqual([...EXPECTED_JOBS]);

    // `jobBody` must return the job, not the whole file: `deploy` is last,
    // so a broken end-of-job boundary is invisible on it. `validate_inputs`
    // is first, so it catches an unbounded slice.
    expect(jobBody('validate_inputs')).toContain('Validate Build Target');
    expect(jobBody('validate_inputs')).not.toContain('Validate Version Input Format\n  setup:');
    expect(jobBody('deploy')).toContain('fail-fast: false');

    // And the timeout reader must be indent-anchored: a step-level cap
    // nested inside a job must not be reported as the job's own.
    const withStepCapOnly = jobBody('deploy').replace(/^ {4}timeout-minutes:.*$/m, '');
    expect(/^ {4}timeout-minutes:/m.test(withStepCapOnly)).toBe(false);
  });

  it('measures a p100 for exactly the jobs that exist', () => {
    // Adding a job without measuring it would otherwise inherit no floor,
    // and the headroom assertions below would skip it in silence.
    expect(Object.keys(MEASURED_P100_MINUTES).sort()).toEqual([...EXPECTED_JOBS].sort());
  });

  it('sets timeout-minutes on every job', () => {
    // The defect: all eight unset, so all eight inherit 360.
    const unset = [...EXPECTED_JOBS].filter((job) => jobTimeout(job) === undefined);
    expect(unset).toEqual([]);
  });

  it('never caps a job at or above GitHub default, so the cap is real', () => {
    // A cap of 360 is the same as no cap, and anything above it is dead
    // configuration that reads as protection.
    const offenders = [...EXPECTED_JOBS]
      .filter((job) => (jobTimeout(job) ?? 0) >= GITHUB_DEFAULT_TIMEOUT_MINUTES)
      .map((job) => `${job}: ${jobTimeout(job)}`);
    expect(offenders).toEqual([]);

    const tooLoose = [...EXPECTED_JOBS]
      .filter((job) => (jobTimeout(job) ?? 0) > MAX_CAP_MINUTES)
      .map((job) => `${job}: ${jobTimeout(job)} > ${MAX_CAP_MINUTES}`);
    expect(tooLoose).toEqual([]);
  });

  it('leaves at least 4x the measured p100 of headroom', () => {
    // The load-bearing direction. Firing on a slow-but-healthy run is the
    // failure mode this whole change has to avoid, so the floor is stated
    // against measured durations rather than intuition. Re-measure before
    // tightening: the numbers in MEASURED_P100_MINUTES have a date on them.
    const offenders = [...EXPECTED_JOBS]
      .filter((job) => (jobTimeout(job) ?? 0) < MEASURED_P100_MINUTES[job] * MIN_HEADROOM_MULTIPLE)
      .map((job) => `${job}: ${jobTimeout(job)} < ${MIN_HEADROOM_MULTIPLE}x p100 ${MEASURED_P100_MINUTES[job]}`);
    expect(offenders).toEqual([]);
  });

  it('gives the prod-mutating jobs extra headroom', () => {
    // A timeout mid-`deploy` lands between `docker stop` and `docker run`
    // and leaves the service down; mid-`migrate` lands inside a schema
    // migration. For these two, a slow run is always the better outcome.
    const offenders = [...PROD_MUTATING_JOBS]
      .filter((job) => (jobTimeout(job) ?? 0) < MEASURED_P100_MINUTES[job] * PROD_MUTATING_HEADROOM_MULTIPLE)
      .map(
        (job) => `${job}: ${jobTimeout(job)} < ${PROD_MUTATING_HEADROOM_MULTIPLE}x p100 ${MEASURED_P100_MINUTES[job]}`
      );
    expect(offenders).toEqual([]);
  });

  it('keeps the two SSH-to-prod-host jobs from being the tightest caps', () => {
    // `deploy` and `reclaim-disk` are the jobs whose stall mode is a
    // wedged host rather than a crash, so they are the ones a cap is
    // actually for -- and the ones where a premature cap costs the most.
    // Neither may be capped below any of the pure-runner jobs.
    const runnerOnly = ['validate_inputs', 'setup', 'handle-git-tags'] as const;
    const runnerCaps = runnerOnly.map((job) => jobTimeout(job));
    // Guard the comparison itself: with every cap unset this would reduce
    // to `0 >= 0` and pass while proving nothing.
    expect(runnerCaps.filter((c) => c === undefined)).toEqual([]);
    const tightestRunnerCap = Math.min(...runnerCaps.map((c) => c ?? 0));
    for (const job of ['deploy', 'reclaim-disk'] as const) {
      expect(jobTimeout(job)).toBeDefined();
      expect(jobTimeout(job) ?? 0).toBeGreaterThanOrEqual(tightestRunnerCap);
    }
  });
});
