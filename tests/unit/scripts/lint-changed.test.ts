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

/**
 * A throwaway git repo holding a copy of the script (it resolves its root from its own location),
 * with fake `npm` and `npx` first on PATH that append "<name> <NODE_OPTIONS> <args>" to a log.
 * `main` is the commit `origin/main` points at; `feature` is a commit on top of it.
 */
function sandbox(opts: {
  originMain: boolean;
  feature: Record<string, string>;
  remove?: string[];
  failNpx?: string;
  failNpm?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-changed-repo-'));
  const git = (...a: string[]) => {
    const res = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`git ${a.join(' ')}: ${res.stderr}`);
    }
    return res.stdout.trim();
  };
  const write = (files: Record<string, string>) => {
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
  };
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(scriptPath, path.join(dir, 'scripts', 'lint-changed.mjs'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  write({
    'apps/a.ts': '1',
    'tests/t.ts': '1',
    'tests/t.test.ts': '1',
    'jobs/j/index.ts': '1',
    'top.ts': '1',
    'README.md': '1',
  });
  git('add', '.');
  git('commit', '-q', '-m', 'main');
  if (opts.originMain) {
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }
  write(opts.feature);
  for (const f of opts.remove ?? []) {
    fs.rmSync(path.join(dir, f));
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'feature');
  const bin = path.join(dir, '.fakebin');
  const log = path.join(dir, '.calls.log');
  fs.mkdirSync(bin);
  for (const name of ['npm', 'npx']) {
    let fail = '';
    if (name === 'npx' && opts.failNpx) {
      fail = `case "$*" in *${opts.failNpx}*) exit 1;; esac\n`;
    } else if (name === 'npm' && opts.failNpm) {
      fail = 'exit 1\n';
    }
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $NODE_OPTIONS $*" >> "${log}"\n${fail}`, {
      mode: 0o755,
    });
  }
  const run = (...args: string[]) => {
    const res = spawnSync('node', ['scripts/lint-changed.mjs', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { status: res.status, stdout: res.stdout, calls };
  };
  return { run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('lint-changed against a real git diff', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));
  const setUp = (opts: Parameters<typeof sandbox>[0]) => {
    const sb = sandbox(opts);
    cleanups.push(sb.cleanup);
    return sb;
  };

  it('lints only the files the branch changed since its merge-base with origin/main', () => {
    const { run } = setUp({ originMain: true, feature: { 'apps/a.ts': '2', 'README.md': '2', 'top.ts': '2' } });
    expect(JSON.parse(run('--dry-run').stdout)).toEqual({ mode: 'files', files: ['apps/a.ts', 'top.ts'] });
  });

  it('ignores deleted files (diff-filter ACMR)', () => {
    const sb = setUp({ originMain: true, feature: {}, remove: ['tests/t.ts'] });
    expect(JSON.parse(sb.run('--dry-run').stdout)).toEqual({ mode: 'skip' });
  });

  it('falls back to full mode when origin/main is missing', () => {
    const { run } = setUp({ originMain: false, feature: { 'apps/a.ts': '2' } });
    const plan = JSON.parse(run('--dry-run').stdout);
    expect(plan.mode).toBe('full');
    expect(plan.groups).toEqual({
      apps: ['apps/a.ts'],
      tests: ['tests/t.test.ts', 'tests/t.ts'],
      jobs: ['jobs/j/index.ts'],
      '.': ['top.ts'],
    });
  });

  it('files mode runs lint:prebuild, then one eslint with --no-warn-ignored and a 6144 MB heap', () => {
    const { run } = setUp({ originMain: true, feature: { 'apps/a.ts': '2', 'tests/t.ts': '2' } });
    const res = run();
    expect(res.status).toBe(0);
    expect(res.calls).toEqual([
      'npm --max-old-space-size=6144 run lint:prebuild',
      'npx --max-old-space-size=6144 eslint --no-warn-ignored apps/a.ts tests/t.ts',
    ]);
  });

  it('full mode runs one eslint process per top-level directory, in sequence, after lint:prebuild', () => {
    const { run } = setUp({ originMain: true, feature: { 'tsconfig.json': '{}' } });
    const res = run();
    expect(res.status).toBe(0);
    expect(res.calls).toEqual([
      'npm --max-old-space-size=6144 run lint:prebuild',
      'npx --max-old-space-size=6144 eslint --no-warn-ignored apps/a.ts',
      'npx --max-old-space-size=6144 eslint --no-warn-ignored jobs/j/index.ts',
      'npx --max-old-space-size=6144 eslint --no-warn-ignored tests/t.test.ts tests/t.ts',
      'npx --max-old-space-size=6144 eslint --no-warn-ignored top.ts',
    ]);
  });

  // git quotes and octal-escapes such paths unless the script asks for NUL-separated output (-z).
  it('lints a changed file whose name has non-ASCII characters (files mode)', () => {
    const { run } = setUp({ originMain: true, feature: { 'apps/caf\u00e9.ts': '2' } });
    expect(JSON.parse(run('--dry-run').stdout)).toEqual({ mode: 'files', files: ['apps/caf\u00e9.ts'] });
  });

  it('lints a tracked file whose name has non-ASCII characters (full mode)', () => {
    const { run } = setUp({ originMain: true, feature: { 'apps/caf\u00e9.ts': '2', 'tsconfig.json': '{}' } });
    const plan = JSON.parse(run('--dry-run').stdout);
    expect(plan.mode).toBe('full');
    expect(plan.groups.apps).toEqual(['apps/a.ts', 'apps/caf\u00e9.ts']);
  });

  it('exits non-zero and runs no eslint group when lint:prebuild fails', () => {
    const { run } = setUp({ originMain: true, feature: { 'tsconfig.json': '{}' }, failNpm: true });
    const res = run();
    expect(res.status).toBe(1);
    expect(res.calls).toEqual(['npm --max-old-space-size=6144 run lint:prebuild']);
  });

  it('skip mode runs nothing and exits 0', () => {
    const { run } = setUp({ originMain: true, feature: { 'README.md': '2' } });
    const res = run();
    expect(res.status).toBe(0);
    expect(res.calls).toEqual([]);
  });

  it('keeps linting the remaining groups after one fails, then exits 1', () => {
    const { run } = setUp({ originMain: true, feature: { 'tsconfig.json': '{}' }, failNpx: 'apps/a.ts' });
    const res = run();
    expect(res.status).toBe(1);
    expect(res.calls.filter((c) => c.startsWith('npx'))).toHaveLength(4);
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

  // A PR that edits only the hook must still run this test, or it reports `skipped`, which branch
  // protection accepts as passing (BS#1807). Returns the `src` filter's entries, comment lines dropped.
  const srcFilter = (): string[] => {
    const lines = fs
      .readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line));
    const start = lines.findIndex((line) => /^\s*src:\s*$/.test(line));
    const entries: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const match = /^\s*- '([^']+)'\s*$/.exec(line);
      if (!match) {
        break;
      }
      entries.push(match[1]);
    }
    return entries;
  };

  it("detect-changes' src filter lists .husky/**", () => {
    expect(srcFilter()).toContain('.husky/**');
  });

  it('exposes the npm script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:changed']).toBe('node scripts/lint-changed.mjs');
  });

  it('explains the 6144 heap next to the 12288 one', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['//lint:changed']).toMatch(/6144.*3\.1 GB.*2\.09 GiB/);
  });
});
