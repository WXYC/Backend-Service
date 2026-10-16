/**
 * Tests for `scripts/resolve-cron-memory.sh`.
 *
 * The script resolves a cron job's optional `cron-memory` cap, which the
 * deploy turns into `docker run --memory=<value>`. It is a sibling of
 * `resolve-cron-schedule.sh`, not an extension, because that script's stdout
 * is a single captured value. Fixtures live in a temporary `CRON_JOBS_DIR`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const JOB = 'digital-assets-sync';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts/resolve-cron-memory.sh');

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(target: string, jobsDir: string): ExecResult {
  try {
    const stdout = execFileSync('bash', [scriptPath, target], {
      cwd: repoRoot,
      env: { ...process.env, CRON_JOBS_DIR: jobsDir },
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

describe('scripts/resolve-cron-memory.sh', () => {
  let jobsDir: string;

  beforeEach(() => {
    jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-memory-'));
  });

  afterEach(() => {
    fs.rmSync(jobsDir, { recursive: true, force: true });
  });

  function writePackage(contents: Record<string, unknown>): void {
    fs.mkdirSync(path.join(jobsDir, JOB), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, JOB, 'package.json'), JSON.stringify(contents));
  }

  it.each([
    ['absent field', {}, '', 0],
    ['megabytes', { 'cron-memory': '192m' }, '192m\n', 0],
    ['gigabytes', { 'cron-memory': '1g' }, '1g\n', 0],
    ['at Docker minimum (6m)', { 'cron-memory': '6m' }, '6m\n', 0],
    ['below Docker minimum (5m)', { 'cron-memory': '5m' }, '', 1],
    ['below Docker minimum (1m)', { 'cron-memory': '1m' }, '', 1],
    ['multi-digit value', { 'cron-memory': '1024m' }, '1024m\n', 0],
    ['zero', { 'cron-memory': '0m' }, '', 1],
    ['no unit', { 'cron-memory': '192' }, '', 1],
    ['two-letter unit', { 'cron-memory': '192mb' }, '', 1],
    ['fractional', { 'cron-memory': '1.5g' }, '', 1],
    ['negative', { 'cron-memory': '-1m' }, '', 1],
    ['number', { 'cron-memory': 192 }, '', 1],
    ['empty string', { 'cron-memory': '' }, '', 1],
  ])('%s', (_name, pkg, expectedStdout, expectedStatus) => {
    writePackage(pkg);
    const { stdout, stderr, status } = run(JOB, jobsDir);
    expect(stdout).toBe(expectedStdout);
    expect(status).toBe(expectedStatus);
    if (expectedStatus !== 0) {
      // Catches a mutation that drops the target or the raw value from the
      // message, e.g. "Invalid cron-memory in jobs/package.json": the target
      // name is distinctive, so 'jobs/' alone cannot satisfy this.
      expect(stderr).toContain(JOB);
      expect(stderr).toContain(JSON.stringify((pkg as Record<string, unknown>)['cron-memory']));
    }
  });

  it('exits non-zero when package.json is missing', () => {
    const { status, stderr } = run(JOB, jobsDir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Missing');
  });
});

/**
 * Dry run of the `CRON_CMD` the Deploy Cron Job step builds. The step lives in
 * workflow YAML, so this extracts the `MEMORY_FLAG` block through the
 * `CRON_CMD=` line, runs it in bash with `CRON_MEMORY` set or empty, and pins
 * the resulting command. It also pins that Get Deploy Vars calls the resolver.
 */
describe('deploy-base.yml cron memory wiring', () => {
  const deployBase = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy-base.yml'), 'utf-8');

  function buildCronCmd(cronMemory: string): string {
    const lines = deployBase.split('\n');
    const start = lines.findIndex((l) => l.trim() === 'MEMORY_FLAG=""');
    const end = lines.findIndex((l, i) => i > start && l.trim().startsWith('CRON_CMD="docker rm -f'));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const snippet = lines
      .slice(start, end + 1)
      .map((l) => l.trim())
      .join('\n');
    const out = execFileSync('bash', ['-c', `${snippet}\nprintf '%s' "$CRON_CMD"`], {
      env: {
        PATH: process.env.PATH,
        CRON_MEMORY: cronMemory,
        TARGET_APP: 'digital-assets-sync',
        DEPLOY_TAG: 'v1.2.3',
        AWS_ECR_URI: 'ecr.example/wxyc',
      },
    });
    return out.toString();
  }

  const base = (flag: string): string =>
    `docker rm -f digital-assets-sync-cron >/dev/null 2>&1 || true; docker run --name digital-assets-sync-cron ${flag}--env-file .env ecr.example/wxyc/digital-assets-sync:v1.2.3`;

  it('adds no flag when the job sets no cron-memory (line matches the pre-cap string)', () => {
    expect(buildCronCmd('')).toBe(base(''));
  });

  it('adds --memory=<value> before --env-file when the job sets cron-memory', () => {
    expect(buildCronCmd('192m')).toBe(base('--memory=192m '));
  });

  it('resolves cron_memory in Get Deploy Vars and passes it to Deploy Cron Job', () => {
    // Catches a later edit that drops the resolver call: capped jobs would run uncapped.
    expect(deployBase).toContain('CRON_MEMORY=$(scripts/resolve-cron-memory.sh "$TARGET_APP")');
    expect(deployBase).toContain('echo "cron_memory=$CRON_MEMORY" >> $GITHUB_OUTPUT');
    expect(deployBase).toContain("CRON_MEMORY='${{ steps.deploy_vars.outputs.cron_memory }}'");
  });
});
