/**
 * One failed build leg fails only its own deploy leg (BS#3614).
 *
 * `build` is a matrix with `fail-fast: false`, but its overall result is
 * "failure" when any one leg fails. `migrate` and `deploy` used to wait on that
 * overall result through the implicit `success()`, so one broken job skipped
 * every target's deploy, backend included.
 *
 * Now both gate on `!cancelled()` plus the jobs they really need, with
 * `build` kept in `needs` for ordering only:
 * - each deploy leg checks that its own image is in ECR, and fails alone if not;
 * - `migrate` checks backend's image when backend is in the run, so a failed
 *   backend build still stops migrations (and, through `migrate`, every deploy
 *   leg), while any other failed leg blocks only itself.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findStep, loadWorkflow, runBashScript, stepEnvFrom } from '../../utils/workflow-step';

const { jobs } = loadWorkflow('deploy-base.yml');
const migrate = jobs.migrate as typeof jobs.migrate & { if: string; needs: string[] };
const deploy = jobs.deploy as typeof jobs.deploy & { if: string; needs: string[] };

const stepNames = (job: typeof jobs.deploy) => job.steps.map((s) => s.name);

describe('migrate and deploy are not gated on the whole build matrix (BS#3614)', () => {
  const prerequisites = ['setup', 'handle-git-tags', 'reclaim-disk', 'build-shared-builder'];

  it.each([
    ['migrate', migrate, prerequisites],
    ['deploy', deploy, [...prerequisites, 'migrate']],
  ])('%s runs unless cancelled, once its real prerequisites succeeded', (_name, job, required) => {
    expect(job.if).toContain('!cancelled()');
    expect(job.if).toContain("needs.setup.outputs.has_targets == 'true'");
    for (const need of required) {
      expect(job.needs).toContain(need);
      expect(job.if).toContain(`needs.${need}.result == 'success'`);
    }
    // `build` orders the job but its aggregate result must not gate it.
    expect(job.needs).toContain('build');
    expect(job.if).not.toContain('needs.build.result');
  });

  it('checks the image before any deploy step in each leg', () => {
    const names = stepNames(deploy);
    const check = names.indexOf('Check image exists in ECR');
    expect(check).toBeGreaterThan(names.indexOf('Determine Target Version'));
    expect(check).toBeLessThan(names.indexOf('Deploy Service'));
    expect(check).toBeLessThan(names.indexOf('Deploy Cron Job'));
  });

  it('checks the backend image, when backend is in the run, before migrating', () => {
    const names = stepNames(migrate);
    expect(names.indexOf('Check backend image')).toBeLessThan(names.indexOf('Run Migrations on EC2'));
    for (const name of ['Download backend version', 'Check backend image']) {
      expect(migrate.steps.find((s) => s.name === name)?.if).toBe(
        "contains(fromJSON(needs.setup.outputs.targets), 'backend')"
      );
    }
  });
});

/**
 * Run each check against an `aws` shim that records its arguments and exits
 * with AWS_EXIT, so a missing image is a non-zero `describe-images`.
 */
describe('image checks fail with a clear error when the image is missing', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-image-check-'));
    fs.writeFileSync(path.join(dir, 'aws'), '#!/bin/sh\necho "aws $*" >> "$AWS_LOG"\nexit "$AWS_EXIT"\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(dir, 'deploy_version.txt'), 'v0.1.7\n');
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const secrets = {
    '${{ secrets.AWS_REGION }}': 'us-east-1',
    '${{ secrets.AWS_ACCESS_KEY_ID }}': 'id',
    '${{ secrets.AWS_SECRET_ACCESS_KEY }}': 'key',
  };
  const checks = [
    [
      'a deploy leg',
      findStep(deploy, 'Check image exists in ECR'),
      {
        ...secrets,
        '${{ matrix.target }}': 'jobs-x',
        '${{ steps.determine_version.outputs.deploy_version }}': 'v0.1.7',
      },
      '--repository-name jobs-x --image-ids imageTag=v0.1.7 --region us-east-1',
      '::error title=No image for jobs-x::',
    ],
    [
      'migrate',
      findStep(migrate, 'Check backend image'),
      secrets,
      '--repository-name backend --image-ids imageTag=v0.1.7 --region us-east-1',
      '::error title=Backend image missing::',
    ],
  ] as const;

  const cases = checks.flatMap(([label, step, exprs, args, error]) => [
    [label, 'present', step, exprs, args, error, '0'] as const,
    [label, 'missing', step, exprs, args, error, '254'] as const,
  ]);

  it.each(cases)('%s with the image %s', (_label, _state, step, exprs, args, error, awsExit) => {
    const log = path.join(dir, `aws-${_label.replace(/\W/g, '')}-${awsExit}.log`);
    const r = runBashScript(step.run, {
      cwd: dir,
      pathPrepend: dir,
      env: { ...stepEnvFrom(step, exprs), AWS_EXIT: awsExit, AWS_LOG: log },
    });
    // The shim records the exact call, so a wrong repository or tag fails here.
    expect(fs.readFileSync(log, 'utf8')).toBe(`aws ecr describe-images ${args}\n`);
    if (awsExit === '0') {
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('::error');
    } else {
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(error);
    }
  });
});
