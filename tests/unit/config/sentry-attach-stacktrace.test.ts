/**
 * Every `Sentry.init` turns `attachStacktrace` off (BS#3002).
 *
 * Sentry 11 defaults it to true. With it on, `captureMessage` attaches a
 * synthetic exception carrying a stack trace, and Sentry titles and groups the
 * event by the top in-app frame. Every app and job here is built with
 * `tsup --minify`, so that frame is a minified name that changes per release:
 * the backend's drift warning arrived as `hS`, `CS`, `IS`, `DS` across four
 * deploys instead of its own text. `false` is the Sentry 10 behavior.
 *
 * There is no shared init helper, so the invariant is pinned across the tree
 * the way `cloudwatch-credentials.test.ts` pins its construction sites.
 */
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const sourceRoots = ['apps', 'jobs', 'shared'];

function walk(dir: string, out: string[]): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|mts|cts)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The argument text of each `Sentry.init(...)` call in `source`, by bracket matching. */
function initArguments(source: string): string[] {
  const args: string[] = [];
  const pattern = /Sentry\.init\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    args.push(source.slice(start, i - 1));
  }
  return args;
}

describe('Sentry.init call sites', () => {
  const sites: Array<{ file: string; args: string }> = [];
  for (const root of sourceRoots) {
    const dir = path.join(repoRoot, root);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir, [])) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const args of initArguments(fs.readFileSync(file, 'utf-8'))) {
        sites.push({ file: path.relative(repoRoot, file), args });
      }
    }
  }

  it('finds the three app preloads and the job loggers', () => {
    const files = sites.map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/backend/instrument.ts',
        'apps/auth/instrument.ts',
        'apps/enrichment-worker/instrument.ts',
      ])
    );
    expect(files.filter((f) => f.startsWith('jobs/')).length).toBeGreaterThanOrEqual(30);
  });

  it('turns attachStacktrace off at every site', () => {
    const missing = sites.filter((s) => !/\battachStacktrace:\s*false\b/.test(s.args)).map((s) => s.file);
    expect(missing).toEqual([]);
  });
});
