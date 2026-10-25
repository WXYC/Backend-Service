/**
 * Behavioral pins for the last line of `.husky/pre-push` (BS#3595): the
 * account-audit coverage check runs dotenvx-wrapped when `.env` exists and
 * with CI's dummy env when it does not, and is hard-fail in both branches.
 *
 * The real hook runs under `sh -e` in a scratch directory with a stub `npm`
 * first on PATH that records each invocation (and the env the dummy branch
 * must supply) and fails on demand.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(__dirname, '../../../.husky/pre-push');
const REAL_PUSH_LINE = `refs/heads/x ${'a'.repeat(40)} refs/heads/x ${'b'.repeat(40)}\n`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pre-push-audit-'));
  const stub = path.join(dir, 'npm');
  writeFileSync(
    stub,
    '#!/bin/sh\necho "$* NODE_ENV=$NODE_ENV DB_HOST=$DB_HOST DB_NAME=$DB_NAME DB_USERNAME=$DB_USERNAME DB_PASSWORD=$DB_PASSWORD" >> "$STUB_LOG"\n[ "$*" = "run $FAIL_ON" ] && exit 1\nexit 0\n'
  );
  chmodSync(stub, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runHook = (opts: { withEnv: boolean; failOn?: string }) => {
  const envFile = path.join(dir, '.env');
  rmSync(envFile, { force: true });
  if (opts.withEnv) writeFileSync(envFile, '');
  const log = path.join(dir, 'calls.log');
  writeFileSync(log, '');
  const r = spawnSync('sh', ['-e', HOOK], {
    cwd: dir,
    input: REAL_PUSH_LINE,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, FAIL_ON: opts.failOn ?? '' },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  return { status: r.status, out: r.stdout + r.stderr, calls };
};

const auditCalls = (calls: string[]) => calls.filter((c) => c.startsWith('run check:audit-coverage'));

describe('pre-push account-audit coverage line', () => {
  it('runs the dotenvx-wrapped script, with no dummy env, when .env exists', () => {
    const { status, calls } = runHook({ withEnv: true });
    expect(status).toBe(0);
    expect(auditCalls(calls)).toEqual([
      'run check:audit-coverage NODE_ENV= DB_HOST= DB_NAME= DB_USERNAME= DB_PASSWORD=',
    ]);
  });

  it('runs the :ci script with CI dummy env and says so when .env is absent', () => {
    const { status, calls, out } = runHook({ withEnv: false });
    expect(status).toBe(0);
    expect(auditCalls(calls)).toEqual([
      'run check:audit-coverage:ci NODE_ENV=test DB_HOST=localhost DB_NAME=dummy DB_USERNAME=dummy DB_PASSWORD=dummy',
    ]);
    expect(out.match(/no \.env/gi)).toHaveLength(1);
  });

  it.each([
    ['with .env', true, 'check:audit-coverage'],
    ['without .env', false, 'check:audit-coverage:ci'],
  ])('fails the hook when the check fails (%s)', (_label, withEnv, script) => {
    const { status } = runHook({ withEnv, failOn: script });
    expect(status).not.toBe(0);
  });

  it.each([true, false])('still runs every other check first (.env present: %s)', (withEnv) => {
    const { calls } = runHook({ withEnv });
    expect(calls.slice(0, 7).map((c) => c.split(' ')[1])).toEqual([
      'typecheck',
      'lint',
      'check:docs',
      'check:auth-tables-doc',
      'check:sql-claim-docs',
      'check:better-auth-mock-sync',
      'check:db-mock-sync',
    ]);
  });
});
