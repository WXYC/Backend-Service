/**
 * Tests for `scripts/check-lml-caller-classification.mjs` (BS#1826 / BS#1842).
 *
 * ts-jest's transform doesn't cover `.mjs` (see `check-legacy-entry-id-writes
 * .test.ts`'s header note), so this file drives the real script as a child
 * process via `spawnSync` rather than importing it. `REPO_ROOT` inside the
 * script is computed from the running file's own `import.meta.url` (`resolve
 * (__dirname, '..')`), not from `cwd` — so copying the script plus the two
 * `shared/lml-client/src/*.ts` files it reads into a temp directory and
 * running the copy from there is a faithful, isolated rerun: no `apps/`/
 * `jobs/` tree is needed because `listSourceFiles` returns `[]` when a root
 * is absent (only the BS#1842 drift-check + the policy parse are exercised).
 *
 * BS#1842's drift-check derives the guard's tracked caller-aware method set
 * from `index.ts` itself and fails (exit 2) on any mismatch against this
 * script's hardcoded `TYPE_REQUIRED_METHODS`/`TYPE_OPTIONAL_METHODS` — the
 * exact "new method silently escapes the guard" gap BS#1842 files. These
 * tests prove both directions of that mismatch are caught, plus that the
 * real, unmodified tree is currently drift-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptRelPath = 'scripts/check-lml-caller-classification.mjs';
const libRelPath = 'scripts/lib/main-module.mjs';
const policyRelPath = 'shared/lml-client/src/policy.ts';
const indexRelPath = 'shared/lml-client/src/index.ts';

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Build a temp copy of just the files the script touches (itself, its one
 * relative import, and the two `shared/lml-client/src/*.ts` files it reads),
 * optionally rewriting `index.ts`'s content first, then run the copied
 * script with `node`.
 */
function runWithIndexSource(transformIndexSrc: (src: string) => string): ExecResult {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bs1842-lml-guard-'));
  try {
    const dirs = ['scripts/lib', 'shared/lml-client/src'];
    for (const d of dirs) fs.mkdirSync(path.join(tmpRoot, d), { recursive: true });

    fs.copyFileSync(path.join(repoRoot, scriptRelPath), path.join(tmpRoot, scriptRelPath));
    fs.copyFileSync(path.join(repoRoot, libRelPath), path.join(tmpRoot, libRelPath));
    fs.copyFileSync(path.join(repoRoot, policyRelPath), path.join(tmpRoot, policyRelPath));

    const realIndexSrc = fs.readFileSync(path.join(repoRoot, indexRelPath), 'utf-8');
    fs.writeFileSync(path.join(tmpRoot, indexRelPath), transformIndexSrc(realIndexSrc));

    const r = spawnSync('node', [path.join(tmpRoot, scriptRelPath)], { encoding: 'utf-8' });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe('check-lml-caller-classification.mjs (BS#1842 method-list drift-check)', () => {
  it('the real, unmodified tree is drift-free (exit 0, PASS)', () => {
    const result = runWithIndexSource((src) => src);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/PASS: every scanned BS→LML call site supplies a registered caller label\./);
  });

  it('fails (exit 2) when index.ts gains a new caller-aware export absent from the guard', () => {
    const result = runWithIndexSource(
      (src) =>
        src +
        '\nexport async function totallyNewLmlMethod(id: number, options: { caller: LmlCaller }): Promise<void> {\n' +
        '  void id;\n' +
        '  void options;\n' +
        '}\n'
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/FAIL\(tooling\): this script's tracked method list has drifted/);
    expect(result.stderr).toMatch(/New caller-aware export\(s\) not in TYPE_REQUIRED_METHODS\/TYPE_OPTIONAL_METHODS/);
    expect(result.stderr).toMatch(/totallyNewLmlMethod/);
  });

  it('fails (exit 2) when index.ts drops the caller field from a currently-tracked export', () => {
    // getRelease is TYPE_OPTIONAL_METHODS-tracked via its `options?: CallerOption`
    // parameter; strip that parameter entirely so the derived set no longer
    // includes it, simulating a rename/removal the guard's hardcoded list forgot
    // to follow.
    const result = runWithIndexSource((src) =>
      src.replace(
        'export async function getRelease(releaseId: number, options?: CallerOption): Promise<DiscogsReleaseMetadata> {',
        'export async function getRelease(releaseId: number): Promise<DiscogsReleaseMetadata> {'
      )
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/FAIL\(tooling\): this script's tracked method list has drifted/);
    expect(result.stderr).toMatch(/Tracked method\(s\) index\.ts no longer marks caller-aware \(renamed\/removed\?\)/);
    expect(result.stderr).toMatch(/getRelease/);
  });

  it('derives caller-awareness through an inline field, a Pick<...> quoted key, and a named-type reference alike', () => {
    // A minimal synthetic index.ts: three ways an export can be caller-aware
    // (matching lookupBySong's Pick<LookupOptions, 'caller'> pattern, an
    // inline object type, and a named-interface reference), plus one control
    // export with no caller involvement at all — must NOT be derived.
    const synthetic = `
      export interface HasCaller { caller?: string; }
      export async function viaNamedType(x: number, options?: HasCaller): Promise<void> { void x; void options; }
      export async function viaInline(x: number, options: { caller: string }): Promise<void> { void x; void options; }
      export async function viaPick(x: number, options?: Pick<HasCaller, 'caller'>): Promise<void> { void x; void options; }
      export async function noCallerAtAll(x: number): Promise<void> { void x; }
    `;
    // policy.ts is copied unmodified (real ALL_LML_CALLERS), so the per-file
    // scan stage still runs against an empty apps/jobs tree (0 violations);
    // only the drift-check's derivation is under test here, and every one of
    // the 11 REAL tracked methods will also read as "missing" from this
    // synthetic file — assert on the specific names this test cares about
    // rather than requiring an exact-match empty diff.
    const result = runWithIndexSource(() => synthetic);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/viaNamedType/);
    expect(result.stderr).toMatch(/viaInline/);
    expect(result.stderr).toMatch(/viaPick/);
    expect(result.stderr).not.toMatch(/noCallerAtAll/);
  });
});
