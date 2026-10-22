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
 * - `migrate` checks the image of every `apps/*` target in the run, because
 *   Dockerfile.migrate applies the whole shared schema. Jobs are left out.
 * All three ECR lookups go through `scripts/ecr-image-exists.sh`.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findStep, loadWorkflow, runBashScript, stepEnvFrom } from '../../utils/workflow-step';

const repoRoot = path.resolve(__dirname, '../../..');
const { jobs } = loadWorkflow('deploy-base.yml');
type GatedJob = typeof jobs.deploy & { if: string; needs: string[] };
const migrate = jobs.migrate as GatedJob;
const deploy = jobs.deploy as GatedJob;
const build = jobs.build as GatedJob;

const normalize = (expr: string) => expr.replace(/\s+/g, ' ').trim();

/**
 * Evaluate a job's `if:` the way GitHub would, for one row of job results.
 * Only `!cancelled()`, `needs.<job>.result`, `needs.setup.outputs.has_targets`,
 * string literals, `==` and `&&` are supported; any other term throws, so a
 * new construct in the expression has to be added here deliberately.
 */
const evaluate = (expr: string, row: { needs: Record<string, string>; cancelled?: boolean; hasTargets?: string }) => {
  const js = normalize(expr)
    .replace(/^\$\{\{|\}\}$/g, '')
    .replace(/!cancelled\(\)/g, String(!row.cancelled))
    .replace(/needs\.setup\.outputs\.has_targets/g, `'${row.hasTargets ?? 'true'}'`)
    .replace(/needs\.([\w-]+)\.result/g, (_m, need: string) => `'${row.needs[need] ?? 'unknown'}'`)
    .trim();
  return js.split('&&').every((term) => {
    const t = term.trim();
    if (t === 'true' || t === 'false') {
      return t === 'true';
    }
    const m = t.match(/^'([^']*)' == '([^']*)'$/);
    if (!m) {
      throw new Error(`unsupported term in if: ${t}`);
    }
    return m[1] === m[2];
  });
};

describe('migrate and deploy are not gated on the whole build matrix (BS#3614)', () => {
  const prerequisites =
    "!cancelled() && needs.setup.outputs.has_targets == 'true' && needs.setup.result == 'success' && " +
    "needs.handle-git-tags.result == 'success' && needs.reclaim-disk.result == 'success' && " +
    "needs.build-shared-builder.result == 'success'";

  it.each([
    ['migrate', migrate, `\${{ ${prerequisites} }}`],
    ['deploy', deploy, `\${{ ${prerequisites} && needs.migrate.result == 'success' }}`],
  ])('pins the whole %s condition', (_name, job, expected) => {
    expect(normalize(job.if)).toBe(expected);
    // `build` orders the job; only its aggregate result is ignored.
    expect(job.needs).toEqual(expect.arrayContaining(['build', 'build-shared-builder']));
  });

  const ok = {
    setup: 'success',
    'handle-git-tags': 'success',
    'reclaim-disk': 'success',
    'build-shared-builder': 'success',
    build: 'success',
    migrate: 'success',
  };
  it.each([
    ['everything succeeded', {}, {}, true, true],
    ['one build leg failed', { build: 'failure' }, {}, true, true],
    ['the shared builder failed', { 'build-shared-builder': 'failure' }, {}, false, false],
    ['handle-git-tags failed', { 'handle-git-tags': 'failure' }, {}, false, false],
    ['reclaim-disk failed', { 'reclaim-disk': 'failure' }, {}, false, false],
    ['migrate failed', { migrate: 'failure' }, {}, true, false],
    ['migrate was skipped', { migrate: 'skipped' }, {}, true, false],
    ['the run was cancelled', {}, { cancelled: true }, false, false],
    ['nothing was affected', {}, { hasTargets: 'false' }, false, false],
  ])('when %s: migrate runs = %s, deploy runs = %s', (_label, results, extra, migrates, deploys) => {
    const row = { needs: { ...ok, ...results }, ...extra };
    expect(evaluate(migrate.if, row)).toBe(migrates);
    expect(evaluate(deploy.if, row)).toBe(deploys);
  });

  it('checks the image before any deploy step in each leg', () => {
    const names = deploy.steps.map((s) => s.name);
    const check = names.indexOf('Check image exists in ECR');
    expect(check).toBeGreaterThan(names.indexOf('Determine Target Version'));
    expect(check).toBeLessThan(names.indexOf('Deploy Service'));
    expect(check).toBeLessThan(names.indexOf('Deploy Cron Job'));
  });

  it('checks the app images before migrating', () => {
    const names = migrate.steps.map((s) => s.name);
    expect(names.indexOf('Download target versions')).toBeLessThan(names.indexOf('Check app images'));
    expect(names.indexOf('Check app images')).toBeLessThan(names.indexOf('Run Migrations on EC2'));
  });

  it.each([
    ['build', build],
    ['deploy', deploy],
  ])('fails %s clearly on an empty deploy version', (_name, job) => {
    const step = findStep(job, 'Determine Target Version');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-version-'));
    try {
      fs.writeFileSync(path.join(dir, 'deploy_version.txt'), '');
      const output = path.join(dir, 'out');
      const r = runBashScript(step.run, { cwd: dir, env: { TARGET_APP: 'jobs-x', GITHUB_OUTPUT: output } });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('::error title=No deploy version::');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Run the three ECR checks for real in a scratch git repo that holds the
 * script, with an `aws` shim on PATH. The shim exits 0 for the repositories
 * in AWS_PRESENT and answers ImageNotFoundException for the rest.
 */
describe('the ECR checks in build, migrate and deploy', () => {
  let dir: string;
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    }
    return r.stdout.trim();
  };
  let sha: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-image-check-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(repoRoot, 'scripts/ecr-image-exists.sh'), path.join(dir, 'scripts/ecr-image-exists.sh'));
    fs.chmodSync(path.join(dir, 'scripts/ecr-image-exists.sh'), 0o755);
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/read-deploy-version.sh'),
      path.join(dir, 'scripts/read-deploy-version.sh')
    );
    fs.chmodSync(path.join(dir, 'scripts/read-deploy-version.sh'), 0o755);
    for (const app of ['backend', 'auth']) {
      fs.mkdirSync(path.join(dir, 'apps', app), { recursive: true });
      fs.writeFileSync(path.join(dir, 'apps', app, 'index.ts'), '');
    }
    for (const [target, version] of [
      ['backend', 'v0.1.7'],
      ['auth', 'v0.2.3'],
      ['jobs-x', 'v0.3.1'],
    ]) {
      fs.mkdirSync(path.join(dir, 'versions', `version-${target}-b1`), { recursive: true });
      fs.writeFileSync(path.join(dir, 'versions', `version-${target}-b1`, 'deploy_version.txt'), `${version}\n`);
    }
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(
      path.join(dir, 'bin', 'aws'),
      [
        '#!/bin/bash',
        'echo "$4:${6#imageTag=}" >> "$AWS_LOG"',
        'case " $AWS_PRESENT " in *" $4 "*) exit 0 ;; esac',
        'echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation" >&2',
        'exit 254',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    git('init', '-q', '-b', 'trunk');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    git('add', 'scripts');
    git('commit', '-qm', 'script');
    sha = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', dir);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const secrets = {
    '${{ secrets.AWS_REGION }}': 'us-east-1',
    '${{ secrets.AWS_ACCESS_KEY_ID }}': 'id',
    '${{ secrets.AWS_SECRET_ACCESS_KEY }}': 'key',
  };
  const leg = {
    ...secrets,
    '${{ matrix.target }}': 'jobs-x',
    '${{ steps.determine_version.outputs.deploy_version }}': 'v0.3.1',
  };
  const runStep = (step: ReturnType<typeof findStep>, exprs: Record<string, string>, present: string) => {
    const log = path.join(dir, `aws-${Math.random().toString(36).slice(2)}.log`);
    const output = path.join(dir, `out-${path.basename(log)}`);
    const r = runBashScript(step.run, {
      cwd: dir,
      pathPrepend: path.join(dir, 'bin'),
      env: {
        ...stepEnvFrom(step, exprs),
        AWS_PRESENT: present,
        AWS_LOG: log,
        GITHUB_OUTPUT: output,
        GITHUB_SHA: sha,
        RUNNER_TEMP: dir,
      },
    });
    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    return { status: r.status, out: r.stdout + r.stderr, lookups: read(log).trim().split('\n'), output: read(output) };
  };

  it.each([
    ['skips the build when the image exists', 'jobs-x', 'image_exists=true'],
    ['builds when the image is missing', '', 'image_exists=false'],
  ])('build %s', (_label, present, output) => {
    const r = runStep(findStep(build, 'Check if image exists in ECR'), leg, present);
    expect(r.status).toBe(0);
    expect(r.lookups).toEqual(['jobs-x:v0.3.1']);
    expect(r.output).toContain(output);
  });

  it.each([
    ['deploys when its image exists', 'jobs-x', 0, ''],
    ['fails alone when its image is missing', '', 1, '::error title=No image for jobs-x::'],
  ])('a deploy leg %s', (_label, present, status, error) => {
    const r = runStep(findStep(deploy, 'Check image exists in ECR'), leg, present);
    expect(r.status).toBe(status);
    expect(r.lookups).toEqual(['jobs-x:v0.3.1']);
    expect(r.out).toContain(error);
  });

  const runMigrateCheck = (present: string, targets = ['auth', 'backend', 'jobs-x'], buildId = 'b1') =>
    runStep(
      findStep(migrate, 'Check app images'),
      {
        ...secrets,
        '${{ needs.setup.outputs.targets }}': JSON.stringify(targets),
        '${{ needs.setup.outputs.build_id }}': buildId,
      },
      present
    );

  it('migrate checks every app in the run, and no job', () => {
    const r = runMigrateCheck('backend auth');
    expect(r.status).toBe(0);
    expect(r.lookups).toEqual(['auth:v0.2.3', 'backend:v0.1.7']);
  });

  // BS#3640: download-artifact extracts a lone matching artifact flat, with no
  // `version-<target>-<build_id>` subfolder.
  it('migrate reads the version of a run that built one app, whose artifact extracted flat', () => {
    const flat = path.join(dir, 'flat-run');
    const versions = path.join(flat, 'versions');
    fs.mkdirSync(versions, { recursive: true });
    fs.writeFileSync(path.join(versions, 'deploy_version.txt'), 'v0.1.7\n');
    fs.mkdirSync(path.join(flat, 'apps/backend'), { recursive: true });
    fs.cpSync(path.join(dir, 'scripts'), path.join(flat, 'scripts'), { recursive: true });
    const step = findStep(migrate, 'Check app images');
    const log = path.join(flat, 'aws.log');
    const r = runBashScript(step.run, {
      cwd: flat,
      pathPrepend: path.join(dir, 'bin'),
      env: {
        ...stepEnvFrom(step, {
          ...secrets,
          '${{ needs.setup.outputs.targets }}': JSON.stringify(['backend']),
          '${{ needs.setup.outputs.build_id }}': 'b1',
        }),
        AWS_PRESENT: 'backend',
        AWS_LOG: log,
      },
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['backend:v0.1.7']);
  });

  it('migrate names the target when its version file is missing', () => {
    const r = runMigrateCheck('backend auth', ['auth', 'backend', 'jobs-x'], 'other-build');
    expect(r.status).toBe(1);
    expect(r.out).toContain('::error title=No deploy version for auth::');
    expect(r.lookups).toEqual(['']);
  });

  it.each([
    ['backend', 'auth', 'backend:v0.1.7'],
    ['auth', 'backend', 'auth:v0.2.3'],
  ])('migrate refuses when the %s image is missing', (_app, present, missing) => {
    const r = runMigrateCheck(present);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`::error title=App image missing::No image in ECR for ${missing}`);
  });
});
