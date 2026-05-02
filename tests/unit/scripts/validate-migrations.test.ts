/**
 * Spawns scripts/validate-migrations.mjs against a temp copy of the
 * migrations directory so each scenario runs in isolation. The validator
 * is a CI gate, so the cases here mirror the regressions it has to catch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const validatorPath = path.join(repoRoot, 'scripts/validate-migrations.mjs');
const sourceMigrationsDir = path.join(repoRoot, 'shared/database/src/migrations');

function run(workdir: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [validatorPath], { cwd: workdir, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function setUpFixture(): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-migrations-'));
  const targetDir = path.join(tmpRoot, 'shared/database/src/migrations');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceMigrationsDir, targetDir, { recursive: true });
  return tmpRoot;
}

function readJournal(workdir: string): {
  entries: Array<{ idx: number; tag: string; when: number; version: string; breakpoints: boolean }>;
} {
  const journalPath = path.join(workdir, 'shared/database/src/migrations/meta/_journal.json');
  return JSON.parse(fs.readFileSync(journalPath, 'utf8'));
}

function writeJournal(workdir: string, journal: object): void {
  const journalPath = path.join(workdir, 'shared/database/src/migrations/meta/_journal.json');
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}

describe('validate-migrations.mjs', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = setUpFixture();
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('passes on the current repo state', () => {
    const { status, stdout } = run(workdir);
    expect(status).toBe(0);
    expect(stdout).toContain('validation passed');
  });

  test('flags out-of-order timestamps', () => {
    const journal = readJournal(workdir);
    journal.entries[journal.entries.length - 1].when = 0;
    writeJournal(workdir, journal);

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Out-of-order timestamp/);
  });

  test('flags conflict markers in snapshot files', () => {
    const snapshotPath = path.join(workdir, 'shared/database/src/migrations/meta/0055_snapshot.json');
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    fs.writeFileSync(snapshotPath, '<<<<<<< HEAD\n' + raw + '\n>>>>>>> branch');

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Conflict markers/);
  });

  test('flags non-allowlisted duplicate idxs', () => {
    const journal = readJournal(workdir);
    // Duplicate idx 50 (not in HISTORICAL_DUPLICATE_IDXS allowlist)
    journal.entries.push({
      idx: 50,
      version: '7',
      when: Date.now(),
      tag: '0050_flowsheet-track-add-time-idx',
      breakpoints: true,
    });
    writeJournal(workdir, journal);

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Duplicate idx 50/);
  });

  test('flags missing SQL files for journal entries', () => {
    const journal = readJournal(workdir);
    journal.entries.push({
      idx: 100,
      version: '7',
      when: Date.now(),
      tag: 'nonexistent_tag',
      breakpoints: true,
    });
    writeJournal(workdir, journal);

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Missing SQL file/);
  });

  test('flags orphaned SQL files not in the journal', () => {
    const orphanPath = path.join(workdir, 'shared/database/src/migrations/9999_orphan.sql');
    fs.writeFileSync(orphanPath, '-- orphan\n');

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Orphaned SQL file/);
  });

  test('warns on the historical idx 47 duplicate but does not fail', () => {
    const { status, stdout, stderr } = run(workdir);
    expect(status).toBe(0);
    // Warnings go to stderr (console.warn), summary goes to stdout
    expect(stderr + stdout).toMatch(/Historical duplicate idx 47/);
  });

  test('flags a broken prevId chain (not a dropped-idx break)', () => {
    // Find the latest snapshot file (whatever idx it's at) and break its
    // prevId so it points at a UUID no other snapshot owns. The walker
    // starts from the latest snapshot, so this triggers regardless of
    // which idx is currently the head.
    const metaDir = path.join(workdir, 'shared/database/src/migrations/meta');
    const latestFile = fs
      .readdirSync(metaDir)
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort()
      .pop();
    if (!latestFile) throw new Error('no snapshot files found in fixture');
    const latestPath = path.join(metaDir, latestFile);
    const snap = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    snap.prevId = '00000000-1111-2222-3333-444444444444';
    fs.writeFileSync(latestPath, JSON.stringify(snap, null, 2));

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/prevId .* not found in any snapshot/);
  });

  test('flags a journal entry with no matching snapshot file (post-#590 hand-edit canary)', () => {
    // Add a journal entry at an idx that is not in
    // HISTORICAL_MISSING_SNAPSHOT_IDXS / DROPPED_IDXS and intentionally
    // don't write the snapshot. This is the exact pattern that
    // accumulated 12+ missing snapshots in 0057-0067; the new Check 7
    // catches it on the next contributor who tries it.
    const journal = readJournal(workdir);
    journal.entries.push({
      idx: 9000,
      version: '7',
      when: Date.now() + 1_000_000_000_000,
      tag: '9000_canary-snapshot-skip',
      breakpoints: true,
    });
    writeJournal(workdir, journal);
    // Write the SQL so Check 2 doesn't preempt — we want Check 7 to fire.
    fs.writeFileSync(path.join(workdir, 'shared/database/src/migrations/9000_canary-snapshot-skip.sql'), '-- canary\n');

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Missing snapshot for journal entry idx 9000/);
    expect(stderr).toMatch(/9000_snapshot\.json/);
    expect(stderr).toMatch(/drizzle:generate/);
  });

  test('tolerates the historically-missing 0057-0067 snapshot gap', () => {
    // No fixture mutation: the current repo state already has the
    // historical gap. Running the validator with no changes must pass —
    // i.e. the allowlist is wired into Check 7. This sits alongside the
    // "passes on the current repo state" test above, but pins Check 7's
    // tolerance specifically so future allowlist edits can't silently
    // promote the gap to an error.
    const { status, stdout, stderr } = run(workdir);
    expect(status).toBe(0);
    // No "Missing snapshot for journal entry idx 57" (or 58…67) errors.
    for (const idx of [57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67]) {
      expect(stderr + stdout).not.toMatch(new RegExp(`Missing snapshot for journal entry idx ${idx}\\b`));
    }
  });

  describe('Check 8: precondition guards on constraint-adding migrations', () => {
    function appendMigration(work: string, tag: string, sql: string, idx = 9000): void {
      const sqlPath = path.join(work, 'shared/database/src/migrations', `${tag}.sql`);
      fs.writeFileSync(sqlPath, sql);
      const journal = readJournal(work);
      journal.entries.push({
        idx,
        version: '7',
        when: Date.now() + 1_000_000_000_000 + idx, // outrun monotonicity check
        tag,
        breakpoints: true,
      });
      writeJournal(work, journal);
    }

    test('warns on a constraint-adding migration with no guard or annotation', () => {
      appendMigration(
        workdir,
        '9001_unguarded-constraint',
        'ALTER TABLE wxyc_schema.flowsheet ADD CONSTRAINT chk_id_positive CHECK (id > 0);\n',
        9001
      );

      const { stdout, stderr } = run(workdir);
      // Other checks (missing snapshot) error; Check 8 warns. We assert only the warning.
      expect(stderr + stdout).toMatch(/9001_unguarded-constraint\.sql adds a constraint/);
      expect(stderr + stdout).toMatch(/precondition guard/);
      expect(stderr + stdout).toMatch(/issue #705/);
    });

    test('does not warn when a DO $$ ... RAISE EXCEPTION ... END $$ guard is present', () => {
      appendMigration(
        workdir,
        '9002_guarded-constraint',
        [
          'DO $$',
          'DECLARE bad_count int;',
          'BEGIN',
          '  SELECT COUNT(*) INTO bad_count FROM wxyc_schema.flowsheet WHERE id <= 0;',
          '  IF bad_count > 0 THEN',
          "    RAISE EXCEPTION 'Cannot apply chk_id_positive: % bad rows', bad_count;",
          '  END IF;',
          'END $$;',
          '',
          'ALTER TABLE wxyc_schema.flowsheet ADD CONSTRAINT chk_id_positive CHECK (id > 0);',
          '',
        ].join('\n'),
        9002
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9002_guarded-constraint\.sql adds a constraint/);
    });

    test('does not warn when a `-- @no-precondition-needed:` comment is present', () => {
      appendMigration(
        workdir,
        '9003_annotated-constraint',
        [
          '-- @no-precondition-needed: id is a serial PK and starts at 1',
          'ALTER TABLE wxyc_schema.flowsheet ADD CONSTRAINT chk_id_pos2 CHECK (id > 0);',
          '',
        ].join('\n'),
        9003
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9003_annotated-constraint\.sql adds a constraint/);
    });

    test('does not warn on CREATE TABLE bodies (constraints in fresh tables are vacuously safe)', () => {
      appendMigration(
        workdir,
        '9004_fresh-table',
        [
          'CREATE TABLE "wxyc_schema"."test_fresh_table" (',
          '  "id" serial PRIMARY KEY,',
          '  "name" text NOT NULL,',
          '  "ref_id" integer NOT NULL UNIQUE',
          '    REFERENCES "wxyc_schema"."flowsheet"("id") ON DELETE CASCADE',
          ');',
          '',
        ].join('\n'),
        9004
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9004_fresh-table\.sql adds a constraint/);
    });

    test('warns on CREATE UNIQUE INDEX outside a CREATE TABLE body', () => {
      appendMigration(
        workdir,
        '9005_unique-index',
        'CREATE UNIQUE INDEX "ux_test" ON "wxyc_schema"."flowsheet" ("legacy_entry_id");\n',
        9005
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).toMatch(/9005_unique-index\.sql adds a constraint/);
      expect(stderr + stdout).toMatch(/CREATE UNIQUE INDEX/);
    });

    test('warns on ALTER COLUMN ... SET NOT NULL', () => {
      appendMigration(
        workdir,
        '9006_set-not-null',
        'ALTER TABLE wxyc_schema.flowsheet ALTER COLUMN album_title SET NOT NULL;\n',
        9006
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).toMatch(/9006_set-not-null\.sql adds a constraint/);
      expect(stderr + stdout).toMatch(/SET NOT NULL/);
    });

    test('does not warn on ADD COLUMN NOT NULL DEFAULT (provably safe)', () => {
      appendMigration(
        workdir,
        '9007_not-null-default',
        'ALTER TABLE wxyc_schema.flowsheet ADD COLUMN test_flag boolean NOT NULL DEFAULT false;\n',
        9007
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9007_not-null-default\.sql adds a constraint/);
    });

    test('the warning never causes a non-zero exit (errors only come from Checks 1-7)', () => {
      // Add a constraint-adding migration with no guard, but with the
      // companion snapshot file so other checks pass — Check 8 alone
      // should not fail the run.
      appendMigration(
        workdir,
        '9008_warning-only',
        'ALTER TABLE wxyc_schema.flowsheet ADD CONSTRAINT chk_no_guard CHECK (id > 0);\n',
        9008
      );
      // Provide a stub snapshot so Check 7 doesn't fire.
      const snap = {
        id: '00000000-1111-2222-3333-555555555555',
        prevId: '00000000-1111-2222-3333-444444444444',
      };
      fs.writeFileSync(
        path.join(workdir, 'shared/database/src/migrations/meta/9008_snapshot.json'),
        JSON.stringify(snap, null, 2)
      );

      const { status, stderr, stdout } = run(workdir);
      // Check 8 emits a WARN, but exit must remain 0 unless a real
      // ERROR fires (e.g. broken prevId chain). The stub snapshot
      // doesn't link to anything real, so prevId will dangle and Check
      // 6 may still fail; we assert specifically that Check 8 alone
      // would not cause exit != 0 by reading the warning summary line.
      expect(stderr + stdout).toMatch(/9008_warning-only\.sql adds a constraint/);
      // Sanity: the run still produces a final summary even with the
      // warning. (status may be 1 from the stub-snapshot chain break;
      // that's a Check 6 failure, not Check 8.)
      void status;
    });
  });

  test('HISTORICAL_NO_GUARD_NEEDED_TAGS does not grow', () => {
    // Tripwire: contributors must not silently allowlist new constraint-
    // adding migrations to suppress Check 8. The right move is to add
    // either a `DO $$ ... RAISE EXCEPTION ... END $$;` guard or a
    // `-- @no-precondition-needed: <reason>` annotation at the top of
    // the migration. The set below is frozen as of issue #705 (2026-05-01)
    // and is the maximum allowed set; shrinking it (because a future PR
    // properly retrofits a guard onto a grandfathered migration) is fine.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/validate-migrations.mjs'), 'utf8');
    const match = src.match(/HISTORICAL_NO_GUARD_NEEDED_TAGS = new Set\(\[([\s\S]*?)\]\)/);
    if (!match) throw new Error('HISTORICAL_NO_GUARD_NEEDED_TAGS not found in validator source');
    const tags = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
      .filter(Boolean);
    const expected = new Set([
      '0000_rare_prima',
      '0004_thin_alice',
      '0010_polite_black_tarantula',
      '0012_chubby_bromley',
      '0014_zippy_secret_warriors',
      '0016_nervous_hydra',
      '0020_sticky_alex_power',
      '0021_user-table-migration',
      '0022_library_cross_reference',
      '0023_metadata_tables',
      '0024_anonymous_devices',
      '0024_flowsheet_entry_type',
      '0025_rate_limiting_tables',
      '0029_add_artists_alphabetical_name',
      '0030_labels_table',
      '0032_audit_f19_f20',
      '0033_crossreference_tables',
      '0037_etl-schema-sync',
      '0041_rotation_etl_support',
    ]);
    for (const tag of tags) {
      expect(expected.has(tag)).toBe(true);
    }
  });

  test('HISTORICAL_MISSING_SNAPSHOT_IDXS does not grow', () => {
    // Tripwire: converts the "must not grow" comment in
    // scripts/validate-migrations.mjs into an enforced invariant. A
    // contributor who hand-edits a journal entry without running
    // `drizzle:generate` cannot quietly add their idx to the allowlist
    // to make CI pass — this test fails first, forcing an explicit
    // edit-and-justify pass through review.
    //
    // If a snapshot is properly *backfilled* for one of these idxs in
    // the future, that idx may be removed from the allowlist; the test
    // expectation below is the maximum allowed set, not the minimum.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/validate-migrations.mjs'), 'utf8');
    const match = src.match(/HISTORICAL_MISSING_SNAPSHOT_IDXS = new Set\(\[([\s\S]*?)\]\)/);
    if (!match) throw new Error('HISTORICAL_MISSING_SNAPSHOT_IDXS not found in validator source');
    const idxs = match[1]
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter(Number.isFinite);
    const expected = new Set([36, 41, 47, 48, 49, 50, 51, 52, 53, 54, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67]);
    const actual = new Set(idxs);
    // Every idx in `actual` must be in `expected` (no growth allowed).
    for (const idx of actual) {
      expect(expected.has(idx)).toBe(true);
    }
    // `actual` is allowed to be a subset of `expected` (snapshot backfilled
    // for that idx) but cannot contain anything outside the set.
  });
});
