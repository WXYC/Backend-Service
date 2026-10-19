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

function run(tscOutput: string[], baseline: Record<string, number>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-typecheck-'));
  const input = path.join(dir, 'tsc.txt');
  const baselinePath = path.join(dir, 'baseline.json');
  fs.writeFileSync(input, tscOutput.join('\n'));
  fs.writeFileSync(baselinePath, JSON.stringify(baseline));
  try {
    return spawnSync('node', [scriptPath, '--input', input, '--baseline', baselinePath], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-tests-typecheck', () => {
  it.each([
    ['no errors and an empty baseline', [], {}, 0],
    ['errors equal to the baseline', [err('tests/a.test.ts'), err('tests/a.test.ts')], { 'tests/a.test.ts': 2 }, 0],
    ['fewer errors than the baseline', [err('tests/a.test.ts')], { 'tests/a.test.ts': 2 }, 0],
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
});
