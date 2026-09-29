/**
 * scripts/check-sql-claim-docs.mjs (BS#2737): the database-free half of the
 * sql-claim check, run in the unconditional `auth-tables-doc-drift` CI job so
 * a docs-only PR cannot skip it. Each case spawns the script against a
 * fixture tree holding only what it reads: docs/ and the workflow file.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-sql-claim-docs.mjs');

const BLOCK = "```sql-claim\nto_tsquery('simple', 'a')  ->  'a'\n```\n";

function workflow(docs: string[]): string {
  const entries = docs.map((d) => `              - '${d}'`).join('\n');
  return [
    'jobs:',
    '  detect-changes:',
    '    steps:',
    '      - with:',
    '          filters: |',
    '            tests:',
    "              - 'tests/**'",
    entries,
    '            db-init:',
    "              - 'dev_env/seed_db.sql'",
    '',
  ].join('\n');
}

function run(files: Record<string, string>, listed: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-claim-docs-'));
  try {
    for (const [p, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), body);
    }
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), workflow(listed));
    const r = spawnSync('node', [scriptPath, root], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('scripts/check-sql-claim-docs.mjs', () => {
  it('passes on this repository', () => {
    const r = spawnSync('node', [scriptPath], { encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).toMatch(/sql-claim docs OK: \d+ claims in \d+ docs/);
    expect(r.status).toBe(0);
  });

  it('passes when every claim-bearing doc is listed and parses', () => {
    const r = run({ 'docs/a.md': BLOCK, 'docs/b.md': 'no claims here\n' }, ['docs/a.md']);
    expect(r).toEqual({ status: 0, out: expect.stringMatching(/1 claims in 1 docs/) });
  });

  it("fails a doc's first block when the doc is missing from the CI filter (the docs-only PR case)", () => {
    const r = run({ 'docs/a.md': BLOCK, 'docs/new.md': BLOCK }, ['docs/a.md']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/docs\/new\.md holds a sql-claim block but is not in .*paths-filter/);
  });

  it('fails a filter entry for a doc that no longer holds a block', () => {
    const r = run({ 'docs/a.md': BLOCK, 'docs/gone.md': 'prose only\n' }, ['docs/a.md', 'docs/gone.md']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/lists docs\/gone\.md, which holds no sql-claim block/);
  });

  it('fails a malformed block by file:line, even one the filter lists', () => {
    const r = run({ 'docs/a.md': 'intro\n```sql-claim\npg_sleep(10)  ->  x\n```\n' }, ['docs/a.md']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/docs\/a\.md:3 +function `pg_sleep` is not in ALLOWED_FUNCTIONS/);
  });

  it('counts a near-miss opener as claim-bearing, so its doc must be listed too', () => {
    const r = run({ 'docs/a.md': "> ```sql-claim\n> 'a'::text  ->  a\n> ```\n" }, []);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/docs\/a\.md:1 +malformed sql-claim fence/);
    expect(r.out).toMatch(/docs\/a\.md holds a sql-claim block but is not in/);
  });
});
