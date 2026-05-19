/**
 * Source-grep + runtime tests for `scripts/check-legacy-entry-id-writes.mjs`.
 *
 * That script pins the three-use invariant of `flowsheet.legacy_entry_id` from
 * BS#908 / Epic H#882. The behavioural test (does the script exit non-zero
 * when a non-allowlisted file gains a `legacy_entry_id:` reference?) runs
 * here against a temp file so future regressions are caught at PR time.
 *
 * The source-grep half pins the allowlist contents: every entry resolves to a
 * real file that contains the pattern, and every file with the pattern is on
 * the allowlist. This prevents the script and the tree from drifting silently.
 *
 * The pattern this test relies on mirrors `format-pg-error.test.ts`: regex the
 * script source rather than dynamic-import the .mjs (ts-jest's transform
 * pattern doesn't cover .mjs and we don't widen it for this).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as os from 'os';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts/check-legacy-entry-id-writes.mjs');
const scriptSource = fs.readFileSync(scriptPath, 'utf-8');

function parseAllowlist(): Map<string, string> {
  // ALLOWLIST is declared as `new Map([[ 'path', 'rationale' ], ...])`; entries
  // span multiple lines because the rationales are prose. We regex the
  // `[ 'key', 'value' ]` pairs out of the source. Single-quoted strings only;
  // any future PR using double quotes or template literals needs to update this.
  const blockMatch = scriptSource.match(/ALLOWLIST\s*=\s*new\s+Map\(\[([\s\S]*?)\]\);/);
  if (!blockMatch) throw new Error('ALLOWLIST not found in check-legacy-entry-id-writes.mjs');
  const pairRe = /\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,?\s*\]/g;
  const pairs = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(blockMatch[1])) !== null) {
    pairs.set(m[1], m[2]);
  }
  if (pairs.size === 0) throw new Error('ALLOWLIST is empty or unparseable');
  return pairs;
}

describe('check-legacy-entry-id-writes.mjs', () => {
  const allowlist = parseAllowlist();

  it('every allowlist entry points to a file that exists', () => {
    for (const rel of allowlist.keys()) {
      const abs = path.join(repoRoot, rel);
      expect(fs.existsSync(abs)).toBe(true);
    }
  });

  it('every allowlist entry has the pattern in its referenced file', () => {
    // If a rationale is "READS only", the file still has the pattern in
    // read-shaped positions (selection clauses, result mapping).
    for (const rel of allowlist.keys()) {
      const abs = path.join(repoRoot, rel);
      const src = fs.readFileSync(abs, 'utf-8');
      expect(src).toMatch(/\blegacy_entry_id:/);
    }
  });

  it('every rationale names one of the documented uses or "READS only" or "column declaration"', () => {
    // Pins the invariant prose to the rationale taxonomy. A new allowlist
    // entry must register its use case in one of these buckets.
    const acceptable = /(use #1|use #2|use #3|READS only|column declaration)/;
    for (const [rel, rationale] of allowlist) {
      if (!acceptable.test(rationale)) {
        throw new Error(
          `Rationale for ${rel} must name use #1/#2/#3, READS only, or column declaration. Got: "${rationale}"`
        );
      }
    }
  });

  it('exits 0 against the current tree', () => {
    // Empty stdio swallow, exit-code is the assertion.
    execFileSync('node', [scriptPath], { cwd: repoRoot, stdio: 'pipe' });
  });

  it('exits 1 when a non-allowlisted file gains the pattern', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-entry-id-test-'));
    const stubInTree = path.join(repoRoot, 'apps/backend/__pin_test_legacy_entry_id__.ts');
    fs.writeFileSync(stubInTree, 'export const stub = { legacy_entry_id: 1 };\n');
    try {
      let exitCode = 0;
      try {
        execFileSync('node', [scriptPath], { cwd: repoRoot, stdio: 'pipe' });
      } catch (e) {
        exitCode = (e as { status: number }).status;
      }
      expect(exitCode).toBe(1);
    } finally {
      fs.unlinkSync(stubInTree);
      fs.rmdirSync(tmpDir);
    }
  });

  it('exits 2 when an allowlist entry no longer contains the pattern', () => {
    // Synthesize the stale-allowlist failure by injecting a fake allowlist
    // entry pointing at a freshly-created empty file. The temp script has to
    // live inside the repo's `scripts/` dir because the script computes
    // `REPO_ROOT = resolve(__dirname, '..')`; placing it under os.tmpdir()
    // would make REPO_ROOT resolve to /var/folders/... and every real
    // allowlist file would be reported missing, accidentally triggering
    // exit 2 for the wrong reason.
    const tmpScriptPath = path.join(repoRoot, 'scripts', `__test_check_legacy_${Date.now()}_${process.pid}.mjs`);
    const tmpStaleFile = path.join(repoRoot, '__pin_test_legacy_entry_id_stale__.ts');
    fs.writeFileSync(tmpStaleFile, '// intentionally empty\n');
    // Format-agnostic injection: insert the new entry just before the closing
    // `])` of the ALLOWLIST Map literal, regardless of whether the surrounding
    // entries are on one line or several.
    const injected = scriptSource.replace(
      /(export const ALLOWLIST = new Map\(\[[\s\S]*?)(\s*\]\);)/,
      `$1\n  ['__pin_test_legacy_entry_id_stale__.ts', 'column declaration (test stub).'],$2`
    );
    if (injected === scriptSource) {
      throw new Error('Failed to inject test allowlist entry; ALLOWLIST literal not found in source.');
    }
    fs.writeFileSync(tmpScriptPath, injected);
    try {
      let exitCode = 0;
      try {
        execFileSync('node', [tmpScriptPath], { cwd: repoRoot, stdio: 'pipe' });
      } catch (e) {
        exitCode = (e as { status: number }).status;
      }
      expect(exitCode).toBe(2);
    } finally {
      fs.unlinkSync(tmpStaleFile);
      fs.unlinkSync(tmpScriptPath);
    }
  });
});
