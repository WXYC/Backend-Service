/**
 * Tests for `scripts/read-deploy-version.sh` (BS#3640).
 *
 * `migrate › Check app images` downloads the run's `version-<target>-<build_id>`
 * artifacts with `actions/download-artifact` and a `pattern:`. With several
 * matches the action puts each artifact in its own subfolder; with exactly one
 * match it extracts it straight into the destination, with no subfolder. The
 * script reads the tag in both layouts, and refuses to guess when a flat file
 * could belong to a different target.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const script = path.resolve(__dirname, '../../../scripts/read-deploy-version.sh');

describe('scripts/read-deploy-version.sh', () => {
  let dir: string;
  let n = 0;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-deploy-version-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Lay out `versions/` from a map of relative path to file content, then run the script. */
  const run = (files: Record<string, string>, target: string, targetCount: number) => {
    const versions = path.join(dir, `case-${n++}`, 'versions');
    fs.mkdirSync(versions, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(versions, rel)), { recursive: true });
      fs.writeFileSync(path.join(versions, rel), content);
    }
    const r = spawnSync('bash', [script, versions, target, 'b1', String(targetCount)], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, versions };
  };

  it.each([
    ['one artifact, flat (BS#3640)', { 'deploy_version.txt': 'v0.1.7\n' }, 'backend', 1],
    [
      'several artifacts, one subfolder each',
      { 'version-backend-b1/deploy_version.txt': 'v0.1.7\n', 'version-auth-b1/deploy_version.txt': 'v0.2.3\n' },
      'backend',
      2,
    ],
    [
      'one app and one job, one subfolder each',
      { 'version-backend-b1/deploy_version.txt': 'v0.1.7\n', 'version-jobs-x-b1/deploy_version.txt': 'v0.3.1\n' },
      'backend',
      2,
    ],
    [
      'a target count of one with a subfolder anyway',
      { 'version-backend-b1/deploy_version.txt': 'v0.1.7\n' },
      'backend',
      1,
    ],
  ])('prints the tag: %s', (_label, files, target, count) => {
    const r = run(files, target, count);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('v0.1.7\n');
    expect(r.stderr).toBe('');
  });

  it('reads the tag of the named target, not another one', () => {
    const r = run(
      { 'version-backend-b1/deploy_version.txt': 'v0.1.7\n', 'version-auth-b1/deploy_version.txt': 'v0.2.3\n' },
      'auth',
      2
    );
    expect(r.stdout).toBe('v0.2.3\n');
  });

  it.each([
    ['nothing was downloaded', {}, 1, 'versions/version-backend-b1/deploy_version.txt'],
    ['the target has no artifact among several', { 'version-auth-b1/deploy_version.txt': 'v0.2.3\n' }, 2, 'backend'],
    [
      'a flat file cannot be attributed, because the run has several targets',
      { 'deploy_version.txt': 'v0.2.3\n' },
      2,
      'cannot tell which target',
    ],
    ['the version file is empty', { 'version-backend-b1/deploy_version.txt': '\n' }, 1, 'is empty'],
  ])('fails with a named error when %s', (_label, files, count, mention) => {
    const r = run(files, 'backend', count);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('::error title=No deploy version for backend::');
    expect(r.stderr).toContain(mention);
  });

  it.each([
    ['nothing was downloaded', {}, 1],
    ['a flat file cannot be attributed', { 'deploy_version.txt': 'v0.2.3\n' }, 2],
  ])('points at the handle-git-tags upload, not a failed build, when %s', (_label, files, count) => {
    const r = run(files, 'backend', count);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('handle-git-tags');
    expect(r.stderr).toContain('version-backend-b1');
    expect(r.stderr).not.toContain('build failed');
  });

  it('never reports the flat file for a target when subfolders exist but not for that target', () => {
    const r = run({ 'deploy_version.txt': 'v0.9.9\n', 'version-auth-b1/deploy_version.txt': 'v0.2.3\n' }, 'backend', 1);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('requires all four arguments', () => {
    const r = spawnSync('bash', [script, dir, 'backend', 'b1'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('usage');
  });
});
