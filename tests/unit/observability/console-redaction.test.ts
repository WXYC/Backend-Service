import { spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
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

// better-auth is ESM-only, so the real router runs in a child process: the fixture is bundled with
// esbuild next to node_modules (so it resolves better-auth) and its real stdout/stderr are captured.
describe('better-auth router logging of a failed name write', () => {
  const outDir = resolve(__dirname, '../../../node_modules/.cache/console-redaction-test');
  const outFile = resolve(outDir, 'drive-better-call.mjs');

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
