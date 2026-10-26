import { describe, it, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

// better-auth is ESM-only, so the real router runs in a child process (same idiom as
// observability/console-redaction.test.ts). The fixture mounts the real `admin()` and `bearer()` plugins
// over an in-memory adapter and drives capability writes as a cookie caller and as a bearer caller.
type Outcome = { update: number; updateStored: string[]; create?: number; createStored?: string[] | null };
type RaceOutcome = { grant: number; revoke: number; code?: string; stored: string[] };
type Unkeyable = Record<string, { status: number; code?: string }>;

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
      // The real turn queue (apps/auth/account-audit-middleware.ts) runs; only its data sources are stubbed.
      alias: {
        '@wxyc/authentication': resolve(__dirname, 'fixtures/stub-authentication.ts'),
        '@wxyc/database': resolve(__dirname, 'fixtures/stub-authentication.ts'),
        '@wxyc/observability': resolve(__dirname, 'fixtures/stub-authentication.ts'),
        'drizzle-orm': resolve(__dirname, 'fixtures/stub-authentication.ts'),
      },
      logLevel: 'silent',
    });
  }, 60_000);

  const drive = (mode: 'plugin' | 'plugin-unqueued' | 'legacy'): Record<string, Outcome & RaceOutcome & Unkeyable> => {
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

  describe('a grant racing a revoke the caller may not make (BS#3716)', () => {
    it('refuses the revoke: the subject queue holds the grant across the guard read and the write, so the guard reads the post-grant value', () => {
      expect(drive('plugin')['race']).toMatchObject({ grant: 200, revoke: 403, stored: ['webmaster'] });
    });

    it('control: with nothing serializing the subject, the stale read lets the revoke wipe the grant', () => {
      expect(drive('plugin-unqueued')['race']).toMatchObject({ grant: 200, revoke: 200, stored: [] });
    });

    it.each([
      ['withoutTurn', 'holds no turn'],
      ['otherSubjectTurn', 'holds the turn for a different subject'],
    ])("refuses a capability write that does not hold the subject's turn (%s: request %s) and never writes", (key) => {
      expect(drive('plugin')[key]).toEqual({
        grant: 200,
        revoke: 400,
        code: 'CAPABILITY_TURN_REQUIRED',
        stored: ['webmaster'],
      });
    });

    it.each(['email-shaped', 'over 32 characters'])(
      'refuses a capabilities write whose userId is %s with 400, before the guard reads or writes',
      (label) => {
        expect(drive('plugin')['unkeyable'][label]).toEqual({ status: 400, code: 'CAPABILITY_TURN_REQUIRED' });
      }
    );

    it('refuses a direct auth.api capability write outside a turn, and lets one inside a turn through', () => {
      expect(drive('plugin')['direct']).toEqual({
        'outside a turn': { status: 400, code: 'CAPABILITY_TURN_REQUIRED', stored: [] },
        'inside a turn': { status: 200, stored: ['webmaster'] },
      });
    });
  });

  it('control: a guard in the user-level hooks.before is bypassed by a bearer caller (the bug)', () => {
    const result = drive('legacy');

    expect(result['director.cookie'].update).toBe(403);
    expect(result['director.bearer']).toMatchObject({ update: 200, updateStored: ['webmaster'], create: 200 });
  });
});
