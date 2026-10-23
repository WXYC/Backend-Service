/**
 * scripts/lint-changed.mjs (BS#3556): picks full, files or skip mode from the
 * changed paths and prints the plan under `--dry-run`. Each case feeds the
 * script a changed-file list (`--changed`) instead of a git diff.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.join(__dirname, '..', '..', '..');
const scriptPath = path.join(root, 'scripts', 'lint-changed.mjs');

function plan(changed: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-changed-'));
  const input = path.join(dir, 'changed.txt');
  fs.writeFileSync(input, changed.join('\n'));
  try {
    const res = spawnSync('node', [scriptPath, '--dry-run', '--changed', input], { encoding: 'utf8', cwd: root });
    return { status: res.status, plan: JSON.parse(res.stdout) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('lint-changed', () => {
  it.each([
    ['nothing changed', [], 'skip'],
    ['only docs and config JSON', ['README.md', 'docs/testing.md', 'tests/typecheck-baseline.json'], 'skip'],
    ['only .mjs files', ['scripts/lint-changed.mjs', 'dev_env/init-db.mjs'], 'skip'],
    ['a .ts file under an ignored path (eslint skips it quietly)', ['scripts/x.ts'], 'files'],
    ['a source file', ['apps/backend/app.ts'], 'files'],
    ['eslint.config.mjs', ['eslint.config.mjs'], 'full'],
    ['an eslint-rules file', ['eslint-rules/restricted-real-name.js'], 'full'],
    ['a tsconfig', ['tests/tsconfig.json'], 'full'],
    ['the jobs lint tsconfig', ['tsconfig.eslint.jobs.json'], 'full'],
    ['a package.json', ['jobs/foo/package.json'], 'full'],
    ['the lockfile', ['package-lock.json'], 'full'],
    ['a .d.ts file', ['apps/backend/types.d.ts'], 'full'],
    ['a trigger alongside source files', ['apps/backend/app.ts', 'package.json'], 'full'],
  ])('%s -> %s', (_name, changed, mode) => {
    const res = plan(changed);
    expect(res.status).toBe(0);
    expect(res.plan.mode).toBe(mode);
  });

  it('files mode lists only lintable extensions', () => {
    const { plan: p } = plan(['apps/backend/app.ts', 'a/b.tsx', 'a/c.mts', 'a/d.cts', 'a/e.js', 'README.md']);
    expect(p.files).toEqual(['apps/backend/app.ts', 'a/b.tsx', 'a/c.mts', 'a/d.cts']);
  });

  it('full mode groups tracked files by top-level directory, one group each', () => {
    const { plan: p } = plan(['package.json']);
    expect(Object.keys(p.groups)).toEqual(expect.arrayContaining(['apps', 'shared', 'jobs', 'tests']));
    for (const [group, files] of Object.entries<string[]>(p.groups)) {
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(/\.(ts|tsx|mts|cts)$/.test(f)).toBe(true);
        expect(group === '.' ? !f.includes('/') : f.startsWith(`${group}/`)).toBe(true);
      }
    }
  });
});

describe('pre-push hook wiring', () => {
  const hook = fs.readFileSync(path.join(root, '.husky', 'pre-push'), 'utf8');
  const commands = hook.split('\n').filter((l) => /^npm run /.test(l));

  it('runs lint:changed, not the full lint', () => {
    expect(commands).toContain('npm run lint:changed');
    expect(commands).not.toContain('npm run lint');
  });

  it('keeps one command per line and the delete-only short-circuit', () => {
    expect(commands.filter((l) => l.includes('&&'))).toEqual([]);
    expect(hook).toContain('has_real_push=false');
    expect(hook).toContain('exit 0');
  });

  it("is listed in detect-changes' src filter", () => {
    const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8');
    const start = yml.split('\n').findIndex((l) => /^\s*src:\s*$/.test(l));
    const entries: string[] = [];
    for (const line of yml.split('\n').slice(start + 1)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*- '([^']+)'\s*$/.exec(line);
      if (!m) break;
      entries.push(m[1]);
    }
    expect(entries).toContain('.husky/**');
  });

  it('exposes the npm script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:changed']).toBe('node scripts/lint-changed.mjs');
  });
});
