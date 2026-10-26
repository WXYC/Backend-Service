import { describe, it, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

// better-auth is ESM-only, so the real router runs in a child process (same idiom as
// observability/console-redaction.test.ts). The fixture mounts the real `admin()` and `bearer()` plugins
// over an in-memory adapter and drives capability writes as a cookie caller and as a bearer caller.
type Outcome = { update: number; updateStored: string[]; create?: number; createStored?: string[] | null };

describe('capability assigner guard against the real better-auth router (BS#3570)', () => {
  const authDir = resolve(__dirname, '../../../shared/authentication');
  const outDir = resolve(authDir, 'node_modules/.cache/capability-guard-test');
  const outFile = resolve(outDir, 'drive-capability-guard.mjs');

  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    await build({
      entryPoints: [resolve(__dirname, 'fixtures/drive-capability-guard.ts')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
  }, 60_000);

  const drive = (mode: 'plugin' | 'legacy'): Record<string, Outcome> => {
    const run = spawnSync(process.execPath, [outFile, mode], { encoding: 'utf8', timeout: 60_000 });
    const line = `${run.stdout}`.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) {
      throw new Error(`fixture produced no result: ${run.stdout}\n${run.stderr}`);
    }
    return JSON.parse(line.slice('RESULT '.length));
  };

  describe('as the inline plugin (production wiring)', () => {
    let result: Record<string, Outcome>;
    beforeAll(() => {
      result = drive('plugin');
    });

    it.each(['cookie', 'bearer'])('lets a station manager write capabilities with %s auth, with grant rows', (via) => {
      expect(result[`manager.${via}`]).toEqual({
        update: 200,
        updateStored: ['webmaster'],
        create: 200,
        createStored: ['editor'],
      });
    });

    it.each(['cookie', 'bearer'])('refuses a non-station-manager admin with %s auth', (via) => {
      expect(result[`director.${via}`]).toEqual({ update: 403, updateStored: [], create: 403, createStored: null });
    });

    it('refuses a capability write that carries no session', () => {
      expect(result['anonymous']).toEqual({ update: 401, updateStored: [] });
    });
  });

  it('control: a guard in the user-level hooks.before is bypassed by a bearer caller (the bug)', () => {
    const result = drive('legacy');

    expect(result['director.cookie'].update).toBe(403);
    expect(result['director.bearer']).toMatchObject({ update: 200, updateStored: ['webmaster'], create: 200 });
  });
});
