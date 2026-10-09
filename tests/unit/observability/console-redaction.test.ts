import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { build } from 'esbuild';
import { installConsoleRedaction } from '@wxyc/observability';
import { realDrizzleQueryError } from '../../utils/postgres-js-errors';

const SENTINEL = 'Test Reviewer';

describe('installConsoleRedaction', () => {
  it('passes the arguments of console.error and console.warn through the redactor, and restores them', () => {
    const error = jest.fn();
    const warn = jest.fn();
    const target = { error, warn };
    const restore = installConsoleRedaction(target);

    target.error('# SERVER_ERROR: ', realDrizzleQueryError([SENTINEL, 'u1']));
    target.warn(`Failed query: select 1\nparams: ${SENTINEL}`);

    expect(JSON.stringify(error.mock.calls, ['0', '1', 'message', 'params', 'stack'])).not.toContain(SENTINEL);
    expect(String(error.mock.calls[0][1].message)).toContain('params: [redacted]');
    expect(warn.mock.calls[0][0]).not.toContain(SENTINEL);

    restore();
    expect(target.error).toBe(error);
    expect(target.warn).toBe(warn);
  });

  it('is idempotent', () => {
    const error = jest.fn();
    const target = { error, warn: jest.fn() };
    const restore = installConsoleRedaction(target);
    const wrapped = target.error;

    installConsoleRedaction(target);

    expect(target.error).toBe(wrapped);
    restore();
  });
});

/** The `better-auth` that Node resolves from `fromDir`: the nearest `node_modules/better-auth` walking up. */
function installedBetterAuth(fromDir: string): { dir: string; version: string } {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const manifest = resolve(dir, 'node_modules/better-auth/package.json');
    if (existsSync(manifest))
      return { dir: dirname(manifest), version: JSON.parse(readFileSync(manifest, 'utf8')).version };
    if (dirname(dir) === dir) throw new Error(`better-auth is not installed above ${fromDir}`);
  }
}

// better-auth is ESM-only, so the real router runs in a child process: the fixture is bundled with
// esbuild and its real stdout/stderr are captured. The bundle is written under shared/authentication so
// the child resolves the better-auth (and better-call) that the auth app runs, not the root copy.
describe('better-auth router logging of a failed name write', () => {
  const authDir = resolve(__dirname, '../../../shared/authentication');
  const outDir = resolve(authDir, 'node_modules/.cache/console-redaction-test');
  const outFile = resolve(outDir, 'drive-better-call.mjs');

  it("runs the better-auth that shared/authentication resolves, so a bump of the app's copy is exercised", () => {
    expect(installedBetterAuth(outDir)).toEqual(installedBetterAuth(authDir));
  });

  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    await build({
      entryPoints: [resolve(__dirname, 'fixtures/drive-better-call.ts')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
  }, 60_000);

  const drive = (mode: 'wrapped' | 'bare') => {
    const run = spawnSync(process.execPath, [outFile, SENTINEL, mode], { encoding: 'utf8', timeout: 60_000 });
    return { output: `${run.stdout}\n${run.stderr}`, status: run.status };
  };

  it('control: without the console wrapper the router prints the raw name (so the next case proves something)', () => {
    const { output } = drive('bare');

    expect(output).toContain('# SERVER_ERROR');
    expect(output).toContain(SENTINEL);
  });

  it('with the wrapper no output holds the name, and the client still gets the same 500', () => {
    const { output, status } = drive('wrapped');

    expect(status).toBe(0);
    expect(output).toContain('# SERVER_ERROR');
    expect(output).not.toContain(SENTINEL);
    expect(output).toContain('STATUS 500 ""');
  });
});
