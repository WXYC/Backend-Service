/**
 * Tests for `scripts/check-auth-tables-doc.mjs` (BS#1573).
 *
 * The script compares:
 *   - the set of `auth_*` string literals passed to `pgTable(...)` under
 *     `shared/database/src/**` (walks the tree since BS#1581)
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

// Exit-code taxonomy (BS#1583). Mirrors the constants exported from the
// script. Tests assert the categorical code so a wording change in the
// human-readable stderr doesn't invalidate the categorical guarantee.
const EXIT_OK = 0;
const EXIT_CONFIG = 2;
const EXIT_DRIFT = 3;
const EXIT_ZERO_TABLES = 4;

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runOnRoot(rootDir: string, opts: { forceCwd?: boolean } = {}): ExecResult {
  // AUTH_TABLES_DOC_FORCE_CWD pins pickRepoRoot() to cwd instead of falling
  // back to the script-parent repo — needed by the missing-file tests below,
  // which delete a required file from the temp root and would otherwise
  // silently pass against the real repo. All other tests build a valid
  // layout in cwd, so the fallback branch is a no-op for them.
  const env = { ...process.env };
  if (opts.forceCwd) env.AUTH_TABLES_DOC_FORCE_CWD = '1';
  const r = spawnSync('node', [scriptPath], {
    cwd: rootDir,
    env,
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
 * Callers can pass `extraSchemaFiles` to simulate a split schema layout
 * (BS#1581).
 */
function setupTempRepo(files: {
  claudeMd: string;
  schemaTs: string;
  extraSchemaFiles?: Record<string, string>;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-tables-doc-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), files.claudeMd);
  const schemaDir = path.join(root, 'shared/database/src');
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.writeFileSync(path.join(schemaDir, 'schema.ts'), files.schemaTs);
  for (const [rel, contents] of Object.entries(files.extraSchemaFiles ?? {})) {
    const abs = path.join(schemaDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
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
    expect(status).toBe(EXIT_OK);
  });

  describe('isolated fixtures', () => {
    // F10 (BS#1582): track every tmpRoot the test body creates and clean them
    // all in afterEach. The prior single-variable form only cleaned the last
    // root a test assigned, which was fine for the current cases but would
    // leak dirs the moment someone added a test that makes two of them.
    const tmpRoots: string[] = [];
    const trackTmpRepo: typeof setupTempRepo = (files) => {
      const root = setupTempRepo(files);
      tmpRoots.push(root);
      return root;
    };
    afterEach(() => {
      for (const root of tmpRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('passes when doc list and schema pgTables match exactly', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user', 'auth_session', 'auth_account']),
        schemaTs: schemaWith(['auth_user', 'auth_session', 'auth_account']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    it('fails when a table is present in schema but missing from the doc', () => {
      // The July 2026 shape: `auth_oauth_consent` is in schema.ts but the
      // author forgot to add it to the CLAUDE.md list. Assert the exit code
      // and the specific table token — the surrounding phrasing ("missing
      // from...") isn't load-bearing (BS#1583 / F12).
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user', 'auth_session']),
        schemaTs: schemaWith(['auth_user', 'auth_session', 'auth_oauth_consent']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_DRIFT);
      expect(stderr).toMatch(/auth_oauth_consent/);
    });

    it('fails when the doc lists a table that is not in the schema', () => {
      // Inverse drift: doc claims a table that no pgTable(...) declares.
      // Could happen from a stale doc after a table was removed.
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user', 'auth_session', 'auth_ghost']),
        schemaTs: schemaWith(['auth_user', 'auth_session']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_DRIFT);
      expect(stderr).toMatch(/auth_ghost/);
    });

    it('ignores non-auth_* pgTables in the schema (scope: auth_* only)', () => {
      // Domain tables (`wxyc_*`, `user_activity`, `anonymous_devices`, etc.)
      // have their own list and their own drift risk. The check is tightly
      // scoped to auth_* to avoid coupling to unrelated schema growth.
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user', 'auth_session']),
        schemaTs: schemaWith(['auth_user', 'auth_session'], ['user_activity', 'anonymous_devices', 'wxyc_flowsheet']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    it('extracts the pgTable() string literal, not the JS export name', () => {
      // The oidcProvider plugin's modelName mapping means the DB table is
      // `auth_oauth_consent` while the export is `oauthConsent`. The doc lists
      // the DB name, so the check must extract the string literal argument.
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_oauth_consent']),
        schemaTs: [
          `import { pgTable, text } from 'drizzle-orm/pg-core';`,
          '',
          `export const oauthConsent = pgTable('auth_oauth_consent', { id: text('id') });`,
          '',
        ].join('\n'),
      });
      const { status } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
    });

    it('fails clearly when the sentinel comments are missing', () => {
      // If the sentinels are stripped, the parser has no durable target.
      // Fail loudly rather than silently allow an empty "doc set".
      const tmpRoot = trackTmpRepo({
        claudeMd: '**Auth tables**: `auth_user`.\n',
        schemaTs: schemaWith(['auth_user']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_CONFIG);
      expect(stderr).toMatch(/sentinel/i);
    });

    // F2: extend the schema-side regex to accept uppercase and backtick args.
    // The prior char class `[a-z0-9_]` missed camelCased table names, and the
    // literal `['"]` quote set missed backtick template-literal args — both
    // are realistic patterns that would silently drop tables from the schema
    // set and hide drift. Mirrors `scripts/schema-shape-report.mjs`.
    it('extracts uppercase table names from pgTable literals', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user', 'auth_UserV2']),
        schemaTs: [
          `import { pgTable, text } from 'drizzle-orm/pg-core';`,
          '',
          `export const authUser = pgTable('auth_user', { id: text('id') });`,
          `export const authUserV2 = pgTable('auth_UserV2', { id: text('id') });`,
          '',
        ].join('\n'),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    it('extracts table names from backtick-quoted pgTable literals', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user', 'auth_new']),
        schemaTs: [
          `import { pgTable, text } from 'drizzle-orm/pg-core';`,
          '',
          `export const authUser = pgTable(\`auth_user\`, { id: text('id') });`,
          `export const authNew = pgTable(\`auth_new\`, { id: text('id') });`,
          '',
        ].join('\n'),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    // F3 (BS#1583): hard-fail with exit-code 4 when the schema regex matches
    // zero tables. If the doc is also empty, both sets agree at 0-vs-0 and
    // the check silently "passes" (the BS#1571 shape). This repo will always
    // have at least `auth_user`.
    it('fails when zero auth_* pgTables are found in the schema', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: [
          '# CLAUDE.md',
          '',
          '<!-- auth-tables-list:begin -->',
          '**Auth tables**: (none).',
          '<!-- auth-tables-list:end -->',
          '',
        ].join('\n'),
        schemaTs: [
          `import { pgTable, text } from 'drizzle-orm/pg-core';`,
          '',
          `export const someDomainTable = pgTable('wxyc_flowsheet', { id: text('id') });`,
          '',
        ].join('\n'),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_ZERO_TABLES);
      expect(stderr).toMatch(/zero|no.*auth_/i);
    });

    // F4: strip HTML comments inside the sentinel block before token
    // extraction. A backticked `auth_*` token inside `<!-- ... -->` is a
    // human note or TODO, not a claim about a real table.
    it('ignores auth_* tokens inside HTML comments in the doc body', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: [
          '# CLAUDE.md',
          '',
          '<!-- auth-tables-list:begin -->',
          '**Auth tables**: `auth_user`.',
          '<!-- TODO: also list `auth_ghost` once BS#9999 lands -->',
          '<!-- auth-tables-list:end -->',
          '',
        ].join('\n'),
        schemaTs: schemaWith(['auth_user']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    // F5b: same treatment for the schema side — a commented-out
    // `// pgTable('auth_legacy', ...)` call should not be counted as a
    // declared table.
    it('ignores pgTable calls inside line comments in the schema', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user']),
        schemaTs: [
          `import { pgTable, text } from 'drizzle-orm/pg-core';`,
          '',
          `export const authUser = pgTable('auth_user', { id: text('id') });`,
          `// export const authLegacy = pgTable('auth_legacy', { id: text('id') });`,
          '',
        ].join('\n'),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    it('ignores pgTable calls inside block comments in the schema', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user']),
        schemaTs: [
          `import { pgTable, text } from 'drizzle-orm/pg-core';`,
          '',
          `export const authUser = pgTable('auth_user', { id: text('id') });`,
          `/*`,
          `  export const authLegacy = pgTable('auth_legacy', { id: text('id') });`,
          `*/`,
          '',
        ].join('\n'),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    // F6: duplicate begin/end sentinels are a silent redefinition risk.
    // The prior `indexOf` picks the first occurrence and slices to the
    // first END — everything past that vanishes. Fail loudly instead.
    it('fails when the begin sentinel appears more than once', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: [
          '# CLAUDE.md',
          '',
          '<!-- auth-tables-list:begin -->',
          '**Auth tables**: `auth_user`.',
          '<!-- auth-tables-list:end -->',
          '',
          '<!-- auth-tables-list:begin -->',
          '(accidental second block)',
          '<!-- auth-tables-list:end -->',
          '',
        ].join('\n'),
        schemaTs: schemaWith(['auth_user']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_CONFIG);
      expect(stderr).toMatch(/duplicate|more than one|multiple.*sentinel/i);
    });

    it('fails when the end sentinel appears more than once', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: [
          '# CLAUDE.md',
          '',
          '<!-- auth-tables-list:begin -->',
          '**Auth tables**: `auth_user`.',
          '<!-- auth-tables-list:end -->',
          '',
          '<!-- auth-tables-list:end -->',
          '',
        ].join('\n'),
        schemaTs: schemaWith(['auth_user']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_CONFIG);
      expect(stderr).toMatch(/duplicate|more than one|multiple.*sentinel/i);
    });

    // R2-4: end-before-begin is a distinct edit mistake from missing
    // sentinels — surface a message that names the actual problem
    // ("inverted") so a reader isn't chasing a phantom "missing" error.
    it('fails with an inverted-order message when end appears before begin', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: [
          '# CLAUDE.md',
          '',
          '<!-- auth-tables-list:end -->',
          '**Auth tables**: `auth_user`.',
          '<!-- auth-tables-list:begin -->',
          '',
        ].join('\n'),
        schemaTs: schemaWith(['auth_user']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_CONFIG);
      // R3-4: assert the distinctive "inverted sentinel comments" wording
      // rather than a permissive alternation. The permissive form would
      // accept the generic "missing sentinel comments" fallback too — the
      // exact miscue R2-4 was supposed to prevent.
      expect(stderr).toMatch(/inverted sentinel comments/);
    });

    // R4-6 (BS#1590): sentinels that appear inside a triple-backtick fenced
    // code block are documentation examples, not real sentinels. The prior
    // indexOf-based counter would trip the duplicate branch on a CLAUDE.md
    // that documents this very check. Strip fenced blocks before counting.
    it('ignores sentinels inside triple-backtick fenced code blocks', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: [
          '# CLAUDE.md',
          '',
          '<!-- auth-tables-list:begin -->',
          '**Auth tables**: `auth_user`.',
          '<!-- auth-tables-list:end -->',
          '',
          '## How this check works',
          '',
          '```md',
          '<!-- auth-tables-list:begin -->',
          '**Auth tables**: `auth_ghost`, `auth_example`.',
          '<!-- auth-tables-list:end -->',
          '```',
          '',
        ].join('\n'),
        schemaTs: schemaWith(['auth_user']),
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    // R3-6 + R4-9 (BS#1590): the "cannot find <required file>" exit branches
    // must report the resolved repo root in the error and produce no stdout.
    // If pickRepoRoot silently regressed (e.g. someone flipped a fallback to
    // cwd), the assertions here would catch the drift because the reported
    // path would no longer include the temp-root dir.
    it('exits with EXIT_CONFIG and a clear message when CLAUDE.md is missing from the repo root', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user']),
        schemaTs: schemaWith(['auth_user']),
      });
      fs.rmSync(path.join(tmpRoot, 'CLAUDE.md'));
      const { status, stdout, stderr } = runOnRoot(tmpRoot, { forceCwd: true });
      expect(status).toBe(EXIT_CONFIG);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/cannot find CLAUDE\.md/);
      // R4-9: assert the resolved path portion of the "looked in <path>"
      // suffix names the temp root. Uses fs.realpathSync because macOS
      // resolves /var/folders/... symlinks to /private/var/folders/... in
      // the script's process.cwd() readout.
      const canonical = fs.realpathSync(tmpRoot);
      expect(stderr).toContain(`looked in ${canonical}`);
    });

    it('exits with EXIT_CONFIG and a clear message when shared/database/src is missing', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user']),
        schemaTs: schemaWith(['auth_user']),
      });
      fs.rmSync(path.join(tmpRoot, 'shared/database/src'), { recursive: true });
      const { status, stdout, stderr } = runOnRoot(tmpRoot, { forceCwd: true });
      expect(status).toBe(EXIT_CONFIG);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/cannot find shared\/database\/src/);
      const canonical = fs.realpathSync(tmpRoot);
      expect(stderr).toContain(`looked in ${canonical}`);
    });

    // BS#1581 (F7): the schema regex walks the tree, so a legitimate split
    // of `schema.ts` into `schema/auth.ts`, `schema/domain.ts`, etc. keeps
    // working with no config file to remember to update. This test writes
    // an `auth_*` declaration into a sibling file and asserts the check
    // still finds it.
    it('discovers auth_* pgTables declared in a sibling schema file', () => {
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user', 'auth_split_out']),
        schemaTs: schemaWith(['auth_user']),
        extraSchemaFiles: {
          'schema/oauth.ts': [
            `import { pgTable, text } from 'drizzle-orm/pg-core';`,
            '',
            `export const splitOut = pgTable('auth_split_out', { id: text('id') });`,
            '',
          ].join('\n'),
        },
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_OK);
      expect(stderr).toBe('');
    });

    it('reports the file that declared each missing table in the drift error', () => {
      // Companion to the split-schema test: when a table declared in a
      // sibling file is missing from the doc, the drift report should name
      // that sibling file (not the original schema.ts) so operators can
      // navigate to the actual declaration.
      const tmpRoot = trackTmpRepo({
        claudeMd: docWith(['auth_user']),
        schemaTs: schemaWith(['auth_user']),
        extraSchemaFiles: {
          'schema/oauth.ts': [
            `import { pgTable, text } from 'drizzle-orm/pg-core';`,
            '',
            `export const splitOut = pgTable('auth_split_out', { id: text('id') });`,
            '',
          ].join('\n'),
        },
      });
      const { status, stderr } = runOnRoot(tmpRoot);
      expect(status).toBe(EXIT_DRIFT);
      expect(stderr).toMatch(/auth_split_out/);
      // The relative path portion of the location marker should include the
      // sibling file, not schema.ts.
      expect(stderr).toMatch(/shared\/database\/src\/schema\/oauth\.ts:/);
    });
  });
});
