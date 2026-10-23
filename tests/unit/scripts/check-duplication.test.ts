/**
 * scripts/check-duplication.mjs (BS#3695): the per-file jscpd ratchet. Most
 * cases feed a canned jscpd report (`--input`) and a fixture baseline; the
 * `real jscpd` cases run npx and need registry access or a warm ~/.npm/_npx cache.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-duplication.mjs');

type Baseline = { scopes: Record<string, { files: Record<string, number> }> };
const src = (name: string, duplicatedTokens: number) => [name, { duplicatedTokens }] as const;
const pair = (a: string, b: string) => ({
  firstFile: { name: a, start: 3, end: 40 },
  secondFile: { name: b, start: 10, end: 47 },
});
/** formats: one entry per jscpd format, each a list of [file, duplicatedTokens]. */
const reportOf = (
  formats: Record<string, Array<readonly [string, { duplicatedTokens: number }]>>,
  pairs = [] as object[]
) =>
  JSON.stringify({
    statistics: {
      formats: Object.fromEntries(Object.entries(formats).map(([f, s]) => [f, { sources: Object.fromEntries(s) }])),
      total: { duplicatedTokens: 7, duplicatedLines: 5, tokens: 100, lines: 50, percentage: 10 },
    },
    duplicates: pairs,
  });

function withDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-dup-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(report: string, baseline: Baseline | null, extra: string[] = [], exitCode = 0) {
  return withDir((dir) => {
    const input = path.join(dir, 'report.json');
    const baselinePath = path.join(dir, 'baseline.json');
    fs.writeFileSync(input, report);
    if (baseline) fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    const res = spawnSync(
      'node',
      [
        scriptPath,
        '--root',
        dir,
        '--input',
        input,
        '--baseline',
        baselinePath,
        '--exit-code',
        String(exitCode),
        ...extra,
      ],
      { encoding: 'utf8' }
    );
    const written = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf8') : null;
    return { ...res, written };
  });
}

const prodBaseline = (files: Record<string, number>): Baseline => ({ scopes: { prod: { files } } });

describe('check-duplication', () => {
  const one = (tokens: number) => reportOf({ typescript: [src('apps/a.ts', tokens)] });

  it.each([
    ['equal to the baseline', 100, 0],
    ['above the baseline', 101, 1],
    ['below the baseline', 99, 0],
  ])('a file %s', (_n, tokens, status) => {
    expect(run(one(tokens), prodBaseline({ 'apps/a.ts': 100 }), ['--scope', 'prod']).status).toBe(status);
  });

  it('notes a fall and tells the author to lock it in', () => {
    const res = run(one(40), prodBaseline({ 'apps/a.ts': 100 }), ['--scope', 'prod']);
    expect(res.stdout).toContain('apps/a.ts fell from 100 to 40');
  });

  it('fails a new file with clones and names the clone pairs touching it', () => {
    const report = reportOf({ typescript: [src('apps/new.ts', 60)] }, [
      pair('apps/new.ts', 'apps/old.ts'),
      pair('apps/x.ts', 'apps/y.ts'),
    ]);
    const res = run(report, prodBaseline({}), ['--scope', 'prod']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('apps/new.ts:3-40 <-> apps/old.ts:10-47');
    expect(res.stderr).not.toContain('apps/x.ts');
  });

  it('sums a file across formats', () => {
    const report = reportOf({ typescript: [src('apps/a.ts', 60)], tsx: [src('apps/a.ts', 50)] });
    expect(run(report, prodBaseline({ 'apps/a.ts': 100 }), ['--scope', 'prod']).status).toBe(1);
    expect(run(report, prodBaseline({ 'apps/a.ts': 110 }), ['--scope', 'prod']).status).toBe(0);
  });

  it('exits 0 with a notice when there is no baseline', () => {
    const res = run(one(500), null, ['--scope', 'prod']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no baseline');
  });

  describe('--update', () => {
    it('lowers counts and drops cleaned files', () => {
      const res = run(one(40), prodBaseline({ 'apps/a.ts': 100, 'apps/gone.ts': 9 }), ['--scope', 'prod', '--update']);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.written)).toEqual({ scopes: { prod: { files: { 'apps/a.ts': 40 } } } });
    });

    it('keeps scopes it was not asked to touch', () => {
      const baseline: Baseline = {
        scopes: { prod: { files: { 'apps/a.ts': 100 } }, tests: { files: { 'tests/t.ts': 5 } } },
      };
      const res = run(one(40), baseline, ['--scope', 'prod', '--update']);
      expect(JSON.parse(res.written).scopes.tests).toEqual({ files: { 'tests/t.ts': 5 } });
    });

    it.each([
      ['a raised file', prodBaseline({ 'apps/a.ts': 10 })],
      ['a new file', prodBaseline({})],
    ])('refuses %s without --allow-increase and writes nothing', (_n, baseline) => {
      const res = run(one(40), baseline, ['--scope', 'prod', '--update']);
      expect(res.status).toBe(1);
      expect(res.written).toBe(JSON.stringify(baseline));
    });

    it('records a raise with --allow-increase', () => {
      const res = run(one(40), prodBaseline({ 'apps/a.ts': 10 }), ['--scope', 'prod', '--update', '--allow-increase']);
      expect(JSON.parse(res.written).scopes.prod.files).toEqual({ 'apps/a.ts': 40 });
    });

    it('creates the baseline when none exists', () => {
      const res = run(one(40), null, ['--scope', 'prod', '--update', '--allow-increase']);
      expect(JSON.parse(res.written).scopes.prod.files).toEqual({ 'apps/a.ts': 40 });
    });
  });

  describe('an unclean jscpd run', () => {
    it.each([
      ['a non-zero exit status', one(40), 134],
      ['an unparseable report', 'not json', 0],
      ['a report with no statistics', '{}', 0],
    ])('fails hard on %s and --update writes nothing', (_n, report, code) => {
      const baseline = prodBaseline({ 'apps/a.ts': 100 });
      expect(run(report, baseline, ['--scope', 'prod'], code).status).toBe(2);
      const res = run(report, baseline, ['--scope', 'prod', '--update', '--allow-increase'], code);
      expect(res.status).toBe(2);
      expect(res.written).toBe(JSON.stringify(baseline));
    });
  });

  describe('--report', () => {
    it('prints the contract JSON for the requested scope', () => {
      const res = run(one(40), null, ['--report', '--scope', 'prod']);
      expect(JSON.parse(res.stdout)).toEqual({
        tool: 'jscpd',
        version: '4.0.5',
        scopes: { prod: { duplicatedTokens: 7, duplicatedLines: 5, totalTokens: 100, totalLines: 50, percentage: 10 } },
      });
    });

    it('covers both scopes without --scope', () => {
      expect(Object.keys(JSON.parse(run(one(40), null, ['--report']).stdout).scopes)).toEqual(['prod', 'tests']);
    });

    it('rejects an unknown scope', () => {
      expect(run(one(40), null, ['--report', '--scope', 'nope']).status).toBe(2);
    });
  });

  it('pins JSCPD_VERSION to the jscpd devDependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const res = spawnSync(
      'node',
      ['--input-type=module', '-e', `import { JSCPD_VERSION as v } from '${scriptPath}'; console.log(v)`],
      {
        encoding: 'utf8',
      }
    );
    expect(pkg.devDependencies.jscpd).toBe(res.stdout.trim());
  });

  describe('real jscpd (needs registry access or a warm ~/.npm/_npx cache)', () => {
    const block = (n: string) =>
      `export function ${n}() {\n${Array.from({ length: 14 }, (_, i) => `  const v${i} = compute(a${i}, b${i}) + other${i}.value * ${i};`).join('\n')}\n  return 1;\n}\n`;
    const real = (files: Record<string, string>, extra: string[]) =>
      withDir((dir) => {
        for (const [f, body] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
          fs.writeFileSync(path.join(dir, f), body);
        }
        return spawnSync('node', [scriptPath, '--root', dir, '--baseline', path.join(dir, 'b.json'), ...extra], {
          encoding: 'utf8',
          cwd: dir, // no node_modules anywhere on the path
          timeout: 180_000,
        });
      });

    it('--report works in a temp tree with no node_modules', () => {
      const res = real({ 'apps/a.ts': block('fa'), 'apps/b.ts': block('fb') }, ['--report', '--scope', 'prod']);
      const prod = JSON.parse(res.stdout).scopes.prod;
      expect(prod.duplicatedTokens).toBeGreaterThan(0);
      expect(prod.totalLines).toBe(32);
    });

    it('counts the same duplicated tokens after a Prettier-style rewrap of a cloned block', () => {
      const wrapped = block('fb').replace(/compute\(a(\d+), b(\d+)\) \+ /g, 'compute(\n    a$1,\n    b$2\n  ) +\n    ');
      const tokens = (b: string) =>
        JSON.parse(real({ 'apps/a.ts': block('fa'), 'apps/b.ts': b }, ['--report', '--scope', 'prod']).stdout).scopes
          .prod.duplicatedTokens;
      expect(tokens(wrapped)).toBe(tokens(block('fb')));
    });
  });
});
