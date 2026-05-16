/**
 * Tests for `scripts/check-bulk-update-analyze.mjs` (BS#934).
 *
 * The script greps `.sql` files under `shared/database/src/migrations/`,
 * `scripts/`, and `jobs/` for top-level `UPDATE` statements, then requires
 * a matching `ANALYZE` for each updated table (or a `-- @no-analyze-needed:`
 * suppression comment).
 *
 * Lesson behind the check: the 2026-05-15 mojibake migration UPDATEd ~61
 * rows across `flowsheet`/`library`/`rotation` columns covered by GIN
 * trigram indexes without running `ANALYZE` afterward. The planner's stats
 * went stale, the dj-site autocomplete `/flowsheet/suggest/*` queries fell
 * off the trigram-index path, and DJs saw 5s timeouts. The check is the
 * static guard against the same shape recurring.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts/check-bulk-update-analyze.mjs');

interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

// Use spawnSync rather than execFileSync so we can read stderr on success
// (exit 0) — the script writes WARN findings to stderr while exiting 0 by
// default, and we need to assert on that output.
function run(env: NodeJS.ProcessEnv = {}): ExecResult {
  const r = spawnSync('node', [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  return {
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    status: r.status ?? 1,
  };
}

function runOnRoot(rootDir: string, strict: boolean): ExecResult {
  const args = [scriptPath];
  if (strict) args.push('--strict');
  const r = spawnSync('node', args, {
    cwd: rootDir,
    env: { ...process.env },
  });
  return {
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    status: r.status ?? 1,
  };
}

function setupTempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-check-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  // The script greps from these dirs; create them empty if not provided so
  // the walk doesn't crash on missing-root.
  for (const dir of ['shared/database/src/migrations', 'scripts', 'jobs']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

describe('check-bulk-update-analyze.mjs', () => {
  it('exits 0 against the current repo (default warn-only mode)', () => {
    // The current tree is allowlisted via per-tag history + suppression
    // annotations. A regression that adds an unannotated UPDATE without
    // ANALYZE would change this.
    const { status } = run();
    expect(status).toBe(0);
  });

  describe('isolated fixtures', () => {
    let tmpRoot: string;
    afterEach(() => {
      if (tmpRoot) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('passes when UPDATE is paired with ANALYZE on the same table', () => {
      tmpRoot = setupTempRepo({
        'scripts/ok.sql': `
          UPDATE wxyc_schema.flowsheet SET artist_name = 'x' WHERE id = 1;
          ANALYZE wxyc_schema.flowsheet;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0);
      expect(stderr).not.toMatch(/WARN/);
    });

    it('passes when bare ANALYZE; covers all UPDATEd tables', () => {
      // Bare ANALYZE (no table) re-stats every table the role can see.
      // We accept it as "covers everything" — safe because the file's UPDATE
      // set is a subset of the role's visible tables.
      tmpRoot = setupTempRepo({
        'scripts/bare-analyze.sql': `
          UPDATE wxyc_schema.flowsheet SET x = 1;
          UPDATE wxyc_schema.rotation SET y = 2;
          ANALYZE;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0);
      expect(stderr).not.toMatch(/WARN/);
    });

    it('passes with the @no-analyze-needed suppression annotation', () => {
      tmpRoot = setupTempRepo({
        'scripts/single-row.sql': `
          -- @no-analyze-needed: single-row UPDATE on a 10-row config table
          UPDATE wxyc_schema.config SET locked = true WHERE key = 'global';
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0);
      expect(stderr).not.toMatch(/WARN/);
    });

    it('warns when UPDATE is unaccompanied by ANALYZE or suppression', () => {
      tmpRoot = setupTempRepo({
        'scripts/bad.sql': `
          UPDATE wxyc_schema.flowsheet SET artist_name = 'x' WHERE id = 1;
          UPDATE wxyc_schema.library SET artist_name = 'y' WHERE id = 1;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0); // warn-only by default
      expect(stderr).toMatch(/scripts\/bad\.sql/);
      expect(stderr).toMatch(/wxyc_schema\.flowsheet/);
      expect(stderr).toMatch(/wxyc_schema\.library/);
    });

    it('warns when ANALYZE covers only a subset of UPDATEd tables', () => {
      tmpRoot = setupTempRepo({
        'scripts/partial.sql': `
          UPDATE wxyc_schema.flowsheet SET x = 1;
          UPDATE wxyc_schema.library SET y = 2;
          ANALYZE wxyc_schema.flowsheet;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0);
      // flowsheet is covered; library is the gap
      expect(stderr).toMatch(/scripts\/partial\.sql/);
      expect(stderr).toMatch(/wxyc_schema\.library/);
      expect(stderr).not.toMatch(/wxyc_schema\.flowsheet/);
    });

    it('exits 1 in --strict mode when an UPDATE is unannotated', () => {
      tmpRoot = setupTempRepo({
        'scripts/bad.sql': `UPDATE wxyc_schema.flowsheet SET x = 1;`,
      });
      const { status, stderr } = runOnRoot(tmpRoot, true);
      expect(status).toBe(1);
      expect(stderr).toMatch(/scripts\/bad\.sql/);
    });

    it('ignores UPDATEs inside SQL line comments (-- UPDATE foo;)', () => {
      tmpRoot = setupTempRepo({
        'scripts/comment.sql': `
          -- UPDATE wxyc_schema.flowsheet SET x = 1; (this is a comment, not a real UPDATE)
          SELECT 1;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0);
      expect(stderr).not.toMatch(/WARN/);
    });

    it('handles UPDATE without a schema prefix (matches by bare table name)', () => {
      tmpRoot = setupTempRepo({
        'scripts/bare.sql': `
          UPDATE flowsheet SET x = 1;
          ANALYZE flowsheet;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0);
      expect(stderr).not.toMatch(/WARN/);
    });

    it('honors the HISTORICAL_NO_ANALYZE_NEEDED_TAGS allowlist for migration files', () => {
      // Migration files are hash-frozen after apply, so adding the
      // suppression comment retroactively would break Check 11. The
      // per-tag allowlist in the script is the escape hatch for already-
      // applied migrations. The check ignores allowlisted tags entirely.
      tmpRoot = setupTempRepo({
        'shared/database/src/migrations/0024_flowsheet_entry_type.sql': `
          UPDATE wxyc_schema.flowsheet SET entry_type = 'track' WHERE entry_type IS NULL;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0);
      expect(stderr).not.toMatch(/WARN/);
    });

    it('does NOT honor the allowlist for non-migration paths', () => {
      // The allowlist matches by migration tag, not arbitrary filename.
      // A new script that happens to share the basename of an allowlisted
      // migration still gets checked.
      tmpRoot = setupTempRepo({
        'scripts/0024_flowsheet_entry_type.sql': `
          UPDATE wxyc_schema.flowsheet SET x = 1;
        `,
      });
      const { status, stderr } = runOnRoot(tmpRoot, false);
      expect(status).toBe(0); // warn-only
      expect(stderr).toMatch(/scripts\/0024_flowsheet_entry_type\.sql/);
    });
  });
});
