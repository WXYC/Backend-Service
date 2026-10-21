/**
 * Tests for `scripts/ecr-image-exists.sh` (BS#3614).
 *
 * The deploy workflow asks ECR whether `<repo>:<tag>` exists in three places:
 * `build` (to skip a rebuild), `migrate` (every app image in the run) and each
 * `deploy` leg (its own image). A missing image and a failed lookup mean
 * different things -- "its build failed" versus throttling, credentials or the
 * network -- so the script reports them with different exit codes, and
 * retries only the second kind.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const script = path.resolve(__dirname, '../../../scripts/ecr-image-exists.sh');

describe('scripts/ecr-image-exists.sh', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecr-image-exists-'));
    // Each call appends its arguments to AWS_LOG, prints the next line of
    // AWS_STDERR (one line per attempt) to stderr, and exits with the
    // matching code from AWS_EXITS.
    fs.writeFileSync(
      path.join(dir, 'aws'),
      [
        '#!/bin/bash',
        'echo "aws $*" >> "$AWS_LOG"',
        'n=$(wc -l < "$AWS_LOG" | tr -d " ")',
        'code=$(echo "$AWS_EXITS" | cut -d, -f"$n")',
        'if [ "$code" != "0" ]; then echo "$AWS_STDERR" >&2; fi',
        'exit "$code"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (exits: string, stderr = '') => {
    const log = path.join(dir, `aws-${exits.replace(/,/g, '-')}-${stderr.length}.log`);
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [script, 'backend', 'v0.1.7'], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        AWS_REGION: 'us-east-1',
        AWS_LOG: log,
        AWS_EXITS: exits,
        AWS_STDERR: stderr,
        ECR_RETRY_DELAY: '0',
      },
      encoding: 'utf8',
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: r.status, stderr: r.stderr, calls };
  };

  const notFound = 'An error occurred (ImageNotFoundException) when calling the DescribeImages operation';
  const noRepo = 'An error occurred (RepositoryNotFoundException) when calling the DescribeImages operation';
  const throttled = 'An error occurred (ThrottlingException) when calling the DescribeImages operation: Rate exceeded';

  it.each([
    ['the image exists', '0', '', 0, 1],
    ['the image is not found', '254', notFound, 1, 1],
    ['the repository does not exist yet', '254', noRepo, 1, 1],
    ['a lookup error clears on retry', '254,0', throttled, 0, 2],
    ['a lookup error persists', '254,254,254', throttled, 2, 3],
  ])('%s', (_label, exits, stderr, status, attempts) => {
    const r = run(exits, stderr);
    expect(r.status).toBe(status);
    expect(r.calls).toHaveLength(attempts);
    expect(r.calls[0]).toBe(
      'aws ecr describe-images --repository-name backend --image-ids imageTag=v0.1.7 --region us-east-1'
    );
  });

  it('names the real cause when the lookup keeps failing, and never calls it a failed build', () => {
    const r = run('254,254,254', throttled);
    expect(r.stderr).toContain('::error title=ECR lookup failed::');
    expect(r.stderr).toContain('ThrottlingException');
    expect(r.stderr).not.toContain('build failed');
  });

  it('reports a missing image without an ::error, so callers word it', () => {
    const r = run('254', notFound);
    expect(r.stderr).not.toContain('::error');
  });
});
