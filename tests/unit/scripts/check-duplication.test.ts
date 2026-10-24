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
type Range = [name: string, start: number, end: number];
/** A clone in the shape jscpd 4.0.5 writes to `duplicates[]` (fields captured from a real run). */
const clone = (a: Range, b: Range, format = 'typescript') => {
  const side = ([name, start, end]: Range) => ({
    name,
    start,
    end,
    startLoc: { line: start, column: 1, position: 0 },
    endLoc: { line: end, column: 2, position: 380 },
  });
  return { format, lines: a[2] - a[1] + 1, tokens: 0, firstFile: side(a), secondFile: side(b) };
};
/** `statistics.formats` carries per-file token counts that the script must not use. */
const reportOf = (duplicates: object[]) =>
  JSON.stringify({
    statistics: {
      formats: { typescript: { sources: { 'apps/a.ts': { duplicatedTokens: 999 } } } },
      total: { duplicatedTokens: 7, duplicatedLines: 5, tokens: 100, lines: 50, percentage: 10 },
    },
    duplicates,
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
  /** apps/a.ts and apps/mirror.ts each duplicate `lines` lines. */
  const one = (lines: number) => reportOf([clone(['apps/a.ts', 1, lines], ['apps/mirror.ts', 1, lines])]);
  const both = (lines: number) => ({ 'apps/a.ts': lines, 'apps/mirror.ts': lines });

  it.each([
    ['equal to the baseline', 100, 0],
    ['above the baseline', 101, 1],
    ['below the baseline', 99, 0],
  ])('a file %s', (_n, lines, status) => {
    expect(run(one(lines), prodBaseline(both(100)), ['--scope', 'prod']).status).toBe(status);
  });

  it('notes a fall and tells the author to lock it in', () => {
    const res = run(one(40), prodBaseline(both(100)), ['--scope', 'prod']);
    expect(res.stdout).toContain('apps/a.ts fell from 100 to 40');
  });

  it('fails a new file with clones and names the clone pairs touching it', () => {
    const report = reportOf([
      clone(['apps/new.ts', 3, 40], ['apps/old.ts', 10, 47]),
      clone(['apps/x.ts', 3, 40], ['apps/y.ts', 10, 47]),
    ]);
    const res = run(report, prodBaseline({ 'apps/x.ts': 38, 'apps/y.ts': 38 }), ['--scope', 'prod']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('apps/new.ts:3-40 <-> apps/old.ts:10-47');
    expect(res.stderr).not.toContain('apps/x.ts');
  });

  const partners = { 'apps/p1.ts': 1000, 'apps/p2.ts': 1000 };

  it('sums a file across formats', () => {
    const report = reportOf([
      clone(['apps/a.ts', 1, 60], ['apps/p1.ts', 1, 60], 'typescript'),
      clone(['apps/a.ts', 100, 149], ['apps/p2.ts', 1, 50], 'tsx'),
    ]);
    expect(run(report, prodBaseline({ ...partners, 'apps/a.ts': 109 }), ['--scope', 'prod']).status).toBe(1);
    expect(run(report, prodBaseline({ ...partners, 'apps/a.ts': 110 }), ['--scope', 'prod']).status).toBe(0);
  });

  it('counts a line once when two clones in one file overlap', () => {
    const report = reportOf([
      clone(['apps/a.ts', 1, 30], ['apps/p1.ts', 1, 30]),
      clone(['apps/a.ts', 20, 50], ['apps/p2.ts', 1, 31]),
    ]);
    expect(run(report, prodBaseline({ ...partners, 'apps/a.ts': 49 }), ['--scope', 'prod']).status).toBe(1);
    expect(run(report, prodBaseline({ ...partners, 'apps/a.ts': 50 }), ['--scope', 'prod']).status).toBe(0);
  });

  describe('a family of four identical copies', () => {
    // jscpd 4.0.5 reports N copies as a star around the last-read copy; deleting that hub
    // copy leaves a different star. Pairs below are from real runs.
    const of4 = reportOf([
      clone(['apps/c.ts', 1, 17], ['apps/d.ts', 1, 17]),
      clone(['apps/b.ts', 1, 17], ['apps/d.ts', 1, 17]),
      clone(['apps/a.ts', 1, 17], ['apps/d.ts', 1, 17]),
    ]);
    const of3 = reportOf([
      clone(['apps/b.ts', 1, 17], ['apps/c.ts', 1, 17]),
      clone(['apps/a.ts', 1, 17], ['apps/c.ts', 1, 17]),
    ]);
    const four = { 'apps/a.ts': 17, 'apps/b.ts': 17, 'apps/c.ts': 17, 'apps/d.ts': 17 };

    it('gives every copy the same count', () => {
      expect(
        JSON.parse(run(of4, null, ['--scope', 'prod', '--update', '--allow-increase']).written).scopes.prod.files
      ).toEqual(four);
    });

    it('passes after the hub copy is deleted, and --update lowers the baseline', () => {
      expect(run(of3, prodBaseline(four), ['--scope', 'prod']).status).toBe(0);
      const res = run(of3, prodBaseline(four), ['--scope', 'prod', '--update']);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.written).scopes.prod.files).toEqual({ 'apps/a.ts': 17, 'apps/b.ts': 17, 'apps/c.ts': 17 });
    });
  });

  describe('with no baseline', () => {
    it.each([
      ['jscpd ran cleanly', 0],
      ['jscpd would have failed, since it is never run', 134],
    ])('exits 0 with a notice when %s', (_n, code) => {
      const res = run(one(500), null, ['--scope', 'prod'], code);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('no baseline');
    });
  });

  describe('--update', () => {
    it('lowers counts and drops cleaned files', () => {
      const res = run(one(40), prodBaseline({ ...both(100), 'apps/gone.ts': 9 }), ['--scope', 'prod', '--update']);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.written)).toEqual({ scopes: { prod: { files: both(40) } } });
    });

    it('keeps scopes it was not asked to touch', () => {
      const baseline: Baseline = {
        scopes: { prod: { files: both(100) }, tests: { files: { 'tests/t.ts': 5 } } },
      };
      const res = run(one(40), baseline, ['--scope', 'prod', '--update']);
      expect(JSON.parse(res.written).scopes.tests).toEqual({ files: { 'tests/t.ts': 5 } });
    });

    it.each([
      ['a raised file', prodBaseline(both(10))],
      ['a new file', prodBaseline({})],
    ])('refuses %s without --allow-increase and writes nothing', (_n, baseline) => {
      const res = run(one(40), baseline, ['--scope', 'prod', '--update']);
      expect(res.status).toBe(1);
      expect(res.written).toBe(JSON.stringify(baseline));
    });

    it('records a raise with --allow-increase', () => {
      const res = run(one(40), prodBaseline(both(10)), ['--scope', 'prod', '--update', '--allow-increase']);
      expect(JSON.parse(res.written).scopes.prod.files).toEqual(both(40));
    });

    it('creates the baseline when none exists', () => {
      const res = run(one(40), null, ['--scope', 'prod', '--update', '--allow-increase']);
      expect(JSON.parse(res.written).scopes.prod.files).toEqual(both(40));
    });
  });

  describe('an unclean jscpd run', () => {
    it.each([
      ['a non-zero exit status', one(40), 134],
      ['an unparseable report', 'not json', 0],
      ['a report with no statistics', '{}', 0],
    ])('fails hard on %s and --update writes nothing', (_n, report, code) => {
      const baseline = prodBaseline(both(100));
      expect(run(report, baseline, ['--scope', 'prod'], code).status).toBe(2);
      const res = run(report, baseline, ['--scope', 'prod', '--update', '--allow-increase'], code);
      expect(res.status).toBe(2);
      expect(res.written).toBe(JSON.stringify(baseline));
    });
  });

  it('exits 2 with the documented message, not a stack trace, when jscpd wrote no report', () => {
    const res = withDir((dir) => {
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(prodBaseline({})));
      return spawnSync(
        'node',
        [scriptPath, '--root', dir, '--input', path.join(dir, 'absent.json'), '--baseline', path.join(dir, 'b.json')],
        {
          encoding: 'utf8',
        }
      );
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('no jscpd report');
    expect(res.stderr).not.toContain('at readFileSync');
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
