/**
 * Tests for `scripts/check-auth-tables-doc.mjs` (BS#1573).
 *
 * The script compares:
 *   - the set of `auth_*` string literals passed to `pgTable(...)` in
 *     `shared/database/src/schema.ts`
 *   - the set of backtick-quoted `auth_*` tokens between the sentinel
 *     comments `<!-- auth-tables-list:begin -->` and
 *     `<!-- auth-tables-list:end -->` in `CLAUDE.md`
 *
 * The failure modes it guards against are the June and July 2026 doc-drift
 * incidents (see BS#1571, BS#1572). The doc-list was a hand-maintained prose
 * line and rotted silently twice: once when `auth_device_code` was added for
 * QR sign-in (ADR 0008) and once when the `oidcProvider` plugin's three
 * tables were missing from both the schema AND the doc. The second incident
 * is the reason this check compares to the Drizzle schema — a runtime canary
 * (WXYC/wxyc-canary#60) probes the OIDC path, but it can't tell you the
 * doc list is stale; that requires this static check.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts/check-auth-tables-doc.mjs');

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runOnRoot(rootDir: string): ExecResult {
  const r = spawnSync('node', [scriptPath], {
    cwd: rootDir,
    env: { ...process.env },
  });
  return {
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    status: r.status ?? 1,
  };
}

function runAgainstRepo(): ExecResult {
  const r = spawnSync('node', [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env },
  });
  return {
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    status: r.status ?? 1,
  };
}

/**
 * Build a synthetic repo layout with just the two files the script reads:
 * `CLAUDE.md` and `shared/database/src/schema.ts`. All test fixtures below
 * use the same shape so the assertions stay focused on the diff logic.
 */
function setupTempRepo(files: { claudeMd: string; schemaTs: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-tables-doc-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), files.claudeMd);
  const schemaDir = path.join(root, 'shared/database/src');
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.writeFileSync(path.join(schemaDir, 'schema.ts'), files.schemaTs);
  return root;
}

function docWith(tables: string[]): string {
  const tokens = tables.map((t) => `\`${t}\``).join(', ');
  return [
    '# CLAUDE.md',
    '',
    '<!-- auth-tables-list:begin -->',
    `**Auth tables** (managed by better-auth): ${tokens}.`,
    '<!-- auth-tables-list:end -->',
    '',
  ].join('\n');
}

function schemaWith(tables: string[], extras: string[] = []): string {
  const authDecls = tables
    .map((t) => `export const ${t.replace(/^auth_/, '')} = pgTable('${t}', { id: text('id') });`)
    .join('\n');
  const extraDecls = extras.map((t) => `export const ${t} = pgTable('${t}', { id: text('id') });`).join('\n');
  return [`import { pgTable, text } from 'drizzle-orm/pg-core';`, '', authDecls, extraDecls, ''].join('\n');
}

describe('check-auth-tables-doc.mjs', () => {
  it('exits 0 against the current repo (doc + schema in sync on main)', () => {
    // A regression that adds an `auth_*` pgTable without updating the CLAUDE.md
    // sentinel-fenced list (or vice versa) would flip this to non-zero.
    const { status } = runAgainstRepo();
    expect(status).toBe(0);
  });

  describe('isolated fixtures', () => {
    let tmpRoot: string;
    afterEach(() => {
      if (tmpRoot) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('passes when doc list and schema pgTables match exactly', () => {
      tmpRoot = setupTempRepo({
        claudeMd: docWith(['auth_user', 'auth_session', 'auth_account']),
        schemaTs: schemaWith(['auth_user', 'auth_session', 'auth_account']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(0);
      expect(stderr).toBe('');
    });

    it('fails when a table is present in schema but missing from the doc', () => {
      // The July 2026 shape: `auth_oauth_consent` is in schema.ts but the
      // author forgot to add it to the CLAUDE.md list.
      tmpRoot = setupTempRepo({
        claudeMd: docWith(['auth_user', 'auth_session']),
        schemaTs: schemaWith(['auth_user', 'auth_session', 'auth_oauth_consent']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(1);
      expect(stderr).toMatch(/auth_oauth_consent/);
      expect(stderr).toMatch(/missing/i);
    });

    it('fails when the doc lists a table that is not in the schema', () => {
      // Inverse drift: doc claims a table that no pgTable(...) declares.
      // Could happen from a stale doc after a table was removed.
      tmpRoot = setupTempRepo({
        claudeMd: docWith(['auth_user', 'auth_session', 'auth_ghost']),
        schemaTs: schemaWith(['auth_user', 'auth_session']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(1);
      expect(stderr).toMatch(/auth_ghost/);
      expect(stderr).toMatch(/extra/i);
    });

    it('ignores non-auth_* pgTables in the schema (scope: auth_* only)', () => {
      // Domain tables (`wxyc_*`, `user_activity`, `anonymous_devices`, etc.)
      // have their own list and their own drift risk. The check is tightly
      // scoped to auth_* to avoid coupling to unrelated schema growth.
      tmpRoot = setupTempRepo({
        claudeMd: docWith(['auth_user', 'auth_session']),
        schemaTs: schemaWith(['auth_user', 'auth_session'], ['user_activity', 'anonymous_devices', 'wxyc_flowsheet']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(0);
      expect(stderr).toBe('');
    });

    it('extracts the pgTable() string literal, not the JS export name', () => {
      // The oidcProvider plugin's modelName mapping means the DB table is
      // `auth_oauth_consent` while the export is `oauthConsent`. The doc lists
      // the DB name, so the check must extract the string literal argument.
      tmpRoot = setupTempRepo({
        claudeMd: docWith(['auth_oauth_consent']),
        schemaTs: [
          `import { pgTable, text } from 'drizzle-orm/pg-core';`,
          '',
          `export const oauthConsent = pgTable('auth_oauth_consent', { id: text('id') });`,
          '',
        ].join('\n'),
      });
      const { status } = runOnRoot(tmpRoot);
      expect(status).toBe(0);
    });

    it('fails clearly when the sentinel comments are missing', () => {
      // If the sentinels are stripped, the parser has no durable target.
      // Fail loudly rather than silently allow an empty "doc set".
      tmpRoot = setupTempRepo({
        claudeMd: '**Auth tables**: `auth_user`.\n',
        schemaTs: schemaWith(['auth_user']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(1);
      expect(stderr).toMatch(/sentinel/i);
    });
  });
});
