/**
 * scripts/check-tests-typecheck.mjs (BS#3509): the per-file error ratchet
 * over `tsc -p tests/tsconfig.json`. Each case feeds the script canned tsc
 * output (`--input`) and a fixture baseline (`--baseline`).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const scriptPath = path.join(__dirname, '..', '..', '..', 'scripts', 'check-tests-typecheck.mjs');

const err = (file: string) => `${file}(1,1): error TS2345: boom`;

function run(tscOutput: string[], baseline: Record<string, number>, extra: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-typecheck-'));
  const input = path.join(dir, 'tsc.txt');
  const baselinePath = path.join(dir, 'baseline.json');
  fs.writeFileSync(input, tscOutput.join('\n'));
  fs.writeFileSync(baselinePath, JSON.stringify(baseline));
  try {
    return spawnSync('node', [scriptPath, '--input', input, '--baseline', baselinePath, ...extra], {
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-tests-typecheck', () => {
  it.each([
    ['no errors and an empty baseline', [], {}, 0],
    ['errors equal to the baseline', [err('tests/a.test.ts'), err('tests/a.test.ts')], { 'tests/a.test.ts': 2 }, 0],
    ['fewer errors than the baseline (stale baseline)', [err('tests/a.test.ts')], { 'tests/a.test.ts': 2 }, 1],
    ['a baseline file that no longer has errors', [], { 'tests/a.test.ts': 1 }, 1],
    ['more errors than the baseline', [err('tests/a.test.ts'), err('tests/a.test.ts')], { 'tests/a.test.ts': 1 }, 1],
    ['an error in a file absent from the baseline', [err('tests/utils/observability.ts')], {}, 1],
  ])('%s', (_name, output, baseline, status) => {
    expect(run(output, baseline).status).toBe(status);
  });

  it('names the offending file when it fails', () => {
    expect(run([err('tests/utils/observability.ts')], {}).stderr).toContain('tests/utils/observability.ts');
  });

  it('ignores continuation lines that are not diagnostics', () => {
    const out = [err('tests/a.test.ts'), "  There are types at 'x', but this could not be resolved"];
    expect(run(out, { 'tests/a.test.ts': 1 }).status).toBe(0);
  });

  it.each([
    ['a fileless error (TS5083)', ["error TS5083: Cannot read file '/x/tests/tsconfig.json'."], 1],
    ['a simulated OOM: non-zero exit and no diagnostics', ['FATAL ERROR: Reached heap limit Allocation failed'], 134],
  ])('fails on an unclean run: %s', (_name, output, code) => {
    const res = run(output, {}, ['--exit-code', String(code)]);
    expect(res.status).toBe(2);
  });

  it('fails on a fileless error even with a zero exit status', () => {
    expect(run(["error TS5083: Cannot read file 'x'."], {}).status).toBe(2);
  });

  it('counts a path containing a space against its own baseline entry', () => {
    const f = 'tests/my dir/a.test.ts';
    expect(run([err(f)], {}).status).toBe(1);
    expect(run([err(f)], { [f]: 1 }).status).toBe(0);
  });

  it('refuses --update after an unclean run and leaves the baseline untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-typecheck-'));
    const input = path.join(dir, 'tsc.txt');
    const baselinePath = path.join(dir, 'baseline.json');
    fs.writeFileSync(input, 'FATAL ERROR: heap');
    fs.writeFileSync(baselinePath, '{"tests/a.test.ts":3}');
    try {
      const res = spawnSync(
        'node',
        [scriptPath, '--input', input, '--baseline', baselinePath, '--exit-code', '134', '--update'],
        { encoding: 'utf8' }
      );
      expect(res.status).toBe(2);
      expect(fs.readFileSync(baselinePath, 'utf8')).toBe('{"tests/a.test.ts":3}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the baseline with --update after a clean run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-typecheck-'));
    const input = path.join(dir, 'tsc.txt');
    const baselinePath = path.join(dir, 'baseline.json');
    fs.writeFileSync(input, err('tests/b.test.ts'));
    try {
      const res = spawnSync('node', [scriptPath, '--input', input, '--baseline', baselinePath, '--update'], {
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))).toEqual({ 'tests/b.test.ts': 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
