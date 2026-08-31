/**
 * Tests for `scripts/ci-env-vars.sh` (BS#2348).
 *
 * `scripts/ci-test.sh` and the `ci:test:parallel` npm script used to expand
 * `${CI_PORT:-8081}` etc. straight from the shell, while
 * `dev_env/docker-compose.yml` resolves the same vars from `.env` via
 * `--env-file`. A checkout whose `.env` carries non-default CI ports got a
 * Docker stack and a test runner pointed at different addresses, and
 * `ci:testmock` timed out in jest's `globalSetup` waiting on the wrong
 * port. `ci-env-vars.sh` is the shared fix: both callers now source it to
 * resolve DB_PORT / PORT / BETTER_AUTH_URL from the same `.env` compose
 * reads, with precedence explicit shell export > `.env` > script default.
 *
 * Behavioral test (spawns bash against a temp PROJECT_ROOT) rather than a
 * source-grep, since the thing under test is the resolution precedence
 * itself, not the script's literal text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts/ci-env-vars.sh');

interface Resolved {
  PORT: string;
  DB_PORT: string;
  AUTH_PORT: string;
  BETTER_AUTH_URL: string;
}

function resolve(opts: { envFileContents?: string; shellEnv?: Record<string, string> }): Resolved {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-env-vars-'));
  try {
    if (opts.envFileContents !== undefined) {
      fs.writeFileSync(path.join(tmpRoot, '.env'), opts.envFileContents);
    }

    // Strip any CI_* values inherited from the parent test process so a
    // scenario that doesn't set them isn't accidentally polluted.
    const baseEnv = { ...process.env };
    delete baseEnv.CI_PORT;
    delete baseEnv.CI_DB_PORT;
    delete baseEnv.CI_AUTH_PORT;
    delete baseEnv.CI_BETTER_AUTH_URL;

    const result = spawnSync(
      'bash',
      [
        '-c',
        `source "${scriptPath}" && printf '%s\\n%s\\n%s\\n%s\\n' "$PORT" "$DB_PORT" "$AUTH_PORT" "$BETTER_AUTH_URL"`,
      ],
      {
        env: { ...baseEnv, ...opts.shellEnv, PROJECT_ROOT: tmpRoot },
      }
    );

    if (result.status !== 0) {
      throw new Error(`ci-env-vars.sh failed: ${result.stderr?.toString()}`);
    }

    const [PORT, DB_PORT, AUTH_PORT, BETTER_AUTH_URL] = result.stdout.toString().trim().split('\n');
    return { PORT, DB_PORT, AUTH_PORT, BETTER_AUTH_URL };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe('scripts/ci-env-vars.sh CI port resolution (BS#2348)', () => {
  it('falls back to the hard-coded defaults when neither .env nor the shell set an override', () => {
    expect(resolve({})).toEqual({
      PORT: '8081',
      DB_PORT: '15433',
      AUTH_PORT: '8083',
      BETTER_AUTH_URL: 'http://localhost:8083/auth',
    });
  });

  it('resolves from .env when the shell has no explicit export -- matches docker compose --env-file', () => {
    const resolved = resolve({
      envFileContents: [
        'CI_PORT=28081',
        'CI_DB_PORT=25433',
        'CI_AUTH_PORT=28083',
        'CI_BETTER_AUTH_URL=http://localhost:28083/auth',
        '',
      ].join('\n'),
    });
    expect(resolved).toEqual({
      PORT: '28081',
      DB_PORT: '25433',
      AUTH_PORT: '28083',
      BETTER_AUTH_URL: 'http://localhost:28083/auth',
    });
  });

  it('derives BETTER_AUTH_URL from CI_AUTH_PORT when .env sets the port but not the URL', () => {
    // The literal BS#2348 acceptance scenario: a .env that carries
    // CI_AUTH_PORT but never bothers to also spell out CI_BETTER_AUTH_URL.
    // Compose only reads CI_AUTH_PORT for its port mapping, so the auth
    // container comes up on 28083 regardless -- BETTER_AUTH_URL must track
    // it rather than falling back to the hard-coded 8083 default.
    const resolved = resolve({
      envFileContents: ['CI_PORT=28081', 'CI_AUTH_PORT=28083', 'CI_DB_PORT=25433', ''].join('\n'),
    });
    expect(resolved.AUTH_PORT).toBe('28083');
    expect(resolved.BETTER_AUTH_URL).toBe('http://localhost:28083/auth');
  });

  it('prefers an explicit shell export over a conflicting .env value', () => {
    const resolved = resolve({
      envFileContents: ['CI_PORT=28081', 'CI_DB_PORT=25433', 'CI_AUTH_PORT=28083', ''].join('\n'),
      shellEnv: { CI_PORT: '9999', CI_AUTH_PORT: '7777' },
    });
    // CI_PORT and CI_AUTH_PORT were exported explicitly, so they win over
    // .env; CI_DB_PORT has no shell export, so it still resolves from .env.
    expect(resolved.PORT).toBe('9999');
    expect(resolved.AUTH_PORT).toBe('7777');
    expect(resolved.DB_PORT).toBe('25433');
  });

  it('prefers an explicit CI_BETTER_AUTH_URL shell export over a conflicting .env CI_AUTH_PORT', () => {
    const resolved = resolve({
      envFileContents: ['CI_AUTH_PORT=28083', ''].join('\n'),
      shellEnv: { CI_BETTER_AUTH_URL: 'http://localhost:9999/auth' },
    });
    // CI_BETTER_AUTH_URL was exported explicitly, so it wins outright for
    // BETTER_AUTH_URL even though .env's CI_AUTH_PORT still resolves
    // AUTH_PORT independently for the harness code paths that read it
    // directly.
    expect(resolved.AUTH_PORT).toBe('28083');
    expect(resolved.BETTER_AUTH_URL).toBe('http://localhost:9999/auth');
  });

  it('mirrors GHA: shell-exported CI_* values win and .env is never consulted', () => {
    // test.yml exports CI_PORT / CI_DB_PORT / CI_BETTER_AUTH_URL at the
    // workflow level (and AUTH_PORT directly, bypassing CI_AUTH_PORT
    // entirely); no .env file exists on the runner at all.
    const resolved = resolve({
      shellEnv: {
        CI_PORT: '8081',
        CI_DB_PORT: '5433',
        CI_BETTER_AUTH_URL: 'http://localhost:8083/auth',
      },
    });
    expect(resolved).toEqual({
      PORT: '8081',
      DB_PORT: '5433',
      AUTH_PORT: '8083',
      BETTER_AUTH_URL: 'http://localhost:8083/auth',
    });
  });

  it('ignores commented-out and unrelated keys in .env', () => {
    const resolved = resolve({
      envFileContents: ['# CI_PORT=1111 (disabled)', 'SOME_OTHER_VAR=hello', 'CI_DB_PORT=25433', ''].join('\n'),
    });
    expect(resolved).toEqual({
      PORT: '8081',
      DB_PORT: '25433',
      AUTH_PORT: '8083',
      BETTER_AUTH_URL: 'http://localhost:8083/auth',
    });
  });
});
