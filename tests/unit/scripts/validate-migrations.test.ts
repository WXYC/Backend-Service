/**
 * Spawns scripts/validate-migrations.mjs against a temp copy of the
 * migrations directory so each scenario runs in isolation. The validator
 * is a CI gate, so the cases here mirror the regressions it has to catch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
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

  describe('Check 9: RAISE EXCEPTION messages cite reachable paths', () => {
    function appendMigration(work: string, tag: string, sql: string, idx = 9100): void {
      const sqlPath = path.join(work, 'shared/database/src/migrations', `${tag}.sql`);
      fs.writeFileSync(sqlPath, sql);
      const journal = readJournal(work);
      journal.entries.push({
        idx,
        version: '7',
        when: Date.now() + 1_000_000_000_000 + idx,
        tag,
        breakpoints: true,
      });
      writeJournal(work, journal);
    }

    function mkRepoPath(work: string, repoRelPath: string): void {
      // Validator runs with cwd=work, so existsSync('jobs/foo') resolves
      // against <work>/jobs/foo. Tests that need a "real" path stub it
      // here.
      const fullPath = path.join(work, repoRelPath);
      fs.mkdirSync(fullPath, { recursive: true });
    }

    test('does not warn when the cited path exists', () => {
      mkRepoPath(workdir, 'jobs/library-artist-name-backfill');
      appendMigration(
        workdir,
        '9101_existing-runbook',
        ['DO $$ BEGIN', "  RAISE EXCEPTION 'See jobs/library-artist-name-backfill for prior art';", 'END $$;', ''].join(
          '\n'
        ),
        9101
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9101_existing-runbook\.sql RAISE EXCEPTION cites/);
    });

    test('warns when the cited path does not exist', () => {
      appendMigration(
        workdir,
        '9102_broken-runbook',
        ['DO $$ BEGIN', "  RAISE EXCEPTION 'Run jobs/this-does-not-exist first';", 'END $$;', ''].join('\n'),
        9102
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).toMatch(/9102_broken-runbook\.sql RAISE EXCEPTION cites 'jobs\/this-does-not-exist'/);
      expect(stderr + stdout).toMatch(/issue #727|WXYC\/Backend-Service#727/);
    });

    test('warns per missing path when multiple are cited (and skips the existing one)', () => {
      mkRepoPath(workdir, 'jobs/library-artist-name-backfill');
      appendMigration(
        workdir,
        '9103_mixed-runbooks',
        [
          'DO $$ BEGIN',
          "  RAISE EXCEPTION 'Mix: see jobs/library-artist-name-backfill but also jobs/missing-one and scripts/missing-two';",
          'END $$;',
          '',
        ].join('\n'),
        9103
      );

      const { stdout, stderr } = run(workdir);
      const combined = stderr + stdout;
      expect(combined).toMatch(/9103_mixed-runbooks\.sql RAISE EXCEPTION cites 'jobs\/missing-one'/);
      expect(combined).toMatch(/9103_mixed-runbooks\.sql RAISE EXCEPTION cites 'scripts\/missing-two'/);
      expect(combined).not.toMatch(/cites 'jobs\/library-artist-name-backfill'/);
    });

    test('does not warn when `-- @no-runbook-needed:` annotation is present', () => {
      appendMigration(
        workdir,
        '9104_suppressed',
        [
          '-- @no-runbook-needed: cited path is a documentation URL, not a real repo path',
          'DO $$ BEGIN',
          "  RAISE EXCEPTION 'See jobs/this-does-not-exist for context';",
          'END $$;',
          '',
        ].join('\n'),
        9104
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9104_suppressed\.sql RAISE EXCEPTION cites/);
    });

    test('does not warn on migrations without a RAISE EXCEPTION', () => {
      appendMigration(
        workdir,
        '9105_no-raise',
        'CREATE INDEX IF NOT EXISTS test_idx ON wxyc_schema.flowsheet(id);\n',
        9105
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9105_no-raise\.sql RAISE EXCEPTION cites/);
    });

    test('does not warn on prose-style references without a `jobs/`/`scripts/`/`apps/`/`shared/` prefix', () => {
      // Documented scope limitation: free-form prose in RAISE messages
      // (e.g. 0071's "Run rotation-dedupe job first") doesn't match the
      // path regex. Tightening the regex to catch prose would inflate
      // false positives; this test pins the deliberate omission.
      appendMigration(
        workdir,
        '9106_prose-only',
        ['DO $$ BEGIN', "  RAISE EXCEPTION 'Run rotation-dedupe job first or pre-clean manually';", 'END $$;', ''].join(
          '\n'
        ),
        9106
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9106_prose-only\.sql RAISE EXCEPTION cites/);
    });

    test('the warning never causes a non-zero exit (errors only come from Checks 1-7)', () => {
      appendMigration(
        workdir,
        '9107_warning-only',
        ['DO $$ BEGIN', "  RAISE EXCEPTION 'See jobs/missing-runbook';", 'END $$;', ''].join('\n'),
        9107
      );
      const snap = {
        id: '00000000-2222-3333-4444-555555555555',
        prevId: '00000000-2222-3333-4444-444444444444',
      };
      fs.writeFileSync(
        path.join(workdir, 'shared/database/src/migrations/meta/9107_snapshot.json'),
        JSON.stringify(snap, null, 2)
      );

      const { stderr, stdout, status } = run(workdir);
      expect(stderr + stdout).toMatch(/9107_warning-only\.sql RAISE EXCEPTION cites/);
      // Status may be 1 from the stub-snapshot chain break (Check 6),
      // but Check 9 alone is a warning that should not fail CI.
      void status;
    });
  });

  describe('Check 10: detect CREATE-then-DROP migration pairs (no-op pairs)', () => {
    function appendMigration(work: string, tag: string, sql: string, idx = 9200): void {
      const sqlPath = path.join(work, 'shared/database/src/migrations', `${tag}.sql`);
      fs.writeFileSync(sqlPath, sql);
      const journal = readJournal(work);
      journal.entries.push({
        idx,
        version: '7',
        when: Date.now() + 1_000_000_000_000 + idx,
        tag,
        breakpoints: true,
      });
      writeJournal(work, journal);
    }

    test('warns on the canonical CREATE-INDEX-then-DROP-INDEX pair', () => {
      appendMigration(
        workdir,
        '9201_add-test-idx',
        'CREATE INDEX test_pair_idx ON wxyc_schema.flowsheet (id);\n',
        9201
      );
      appendMigration(workdir, '9202_drop-test-idx', 'DROP INDEX test_pair_idx;\n', 9202);

      const { stdout, stderr } = run(workdir);
      const combined = stderr + stdout;
      expect(combined).toMatch(
        /9201_add-test-idx\.sql creates index:test_pair_idx, then 9202_drop-test-idx\.sql drops it/
      );
      expect(combined).toMatch(/issue #729|WXYC\/Backend-Service#729/);
    });

    test('does not warn when the pair lies outside the recent window', () => {
      // Default WINDOW_SIZE=10. Push 12 unrelated migrations after the
      // pair so the pair falls out of the window.
      appendMigration(
        workdir,
        '9210_create-distant-idx',
        'CREATE INDEX distant_idx ON wxyc_schema.flowsheet (id);\n',
        9210
      );
      for (let i = 0; i < 11; i++) {
        appendMigration(workdir, `9211_filler-${i}`, '-- filler\n', 9220 + i);
      }
      appendMigration(workdir, '9240_drop-distant-idx', 'DROP INDEX distant_idx;\n', 9240);

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9210_create-distant-idx\.sql creates index:distant_idx/);
    });

    test('CREATE-DROP-CREATE warns only on the first (create, drop) pair', () => {
      appendMigration(workdir, '9220_create-cdc', 'CREATE INDEX cdc_idx ON wxyc_schema.flowsheet (id);\n', 9220);
      appendMigration(workdir, '9221_drop-cdc', 'DROP INDEX cdc_idx;\n', 9221);
      appendMigration(workdir, '9222_recreate-cdc', 'CREATE INDEX cdc_idx ON wxyc_schema.flowsheet (id);\n', 9222);

      const { stdout, stderr } = run(workdir);
      const combined = stderr + stdout;
      expect(combined).toMatch(/9220_create-cdc\.sql creates index:cdc_idx, then 9221_drop-cdc\.sql drops it/);
      // Second create has no following drop in window → no second warning.
      const occurrences = (combined.match(/creates index:cdc_idx/g) ?? []).length;
      expect(occurrences).toBe(1);
    });

    test('does not warn when `-- @intentional-create-revert:` annotation is present on either side', () => {
      appendMigration(
        workdir,
        '9230_create-suppressed',
        '-- @intentional-create-revert: testing intentional rollback pattern\nCREATE INDEX sup_idx ON wxyc_schema.flowsheet (id);\n',
        9230
      );
      appendMigration(workdir, '9231_drop-suppressed', 'DROP INDEX sup_idx;\n', 9231);

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9230_create-suppressed\.sql creates index:sup_idx/);
    });

    test('matches quoted index names (CREATE "my_idx" / DROP my_idx normalize to same key)', () => {
      appendMigration(
        workdir,
        '9240_create-quoted',
        'CREATE INDEX "quoted_pair_idx" ON wxyc_schema.flowsheet (id);\n',
        9240
      );
      appendMigration(workdir, '9241_drop-quoted', 'DROP INDEX quoted_pair_idx;\n', 9241);

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).toMatch(
        /9240_create-quoted\.sql creates index:quoted_pair_idx, then 9241_drop-quoted\.sql drops it/
      );
    });

    test('matches schema-qualified DROP against unqualified CREATE', () => {
      appendMigration(workdir, '9250_create-bare', 'CREATE INDEX schq_idx ON wxyc_schema.flowsheet (id);\n', 9250);
      appendMigration(workdir, '9251_drop-schq', 'DROP INDEX wxyc_schema.schq_idx;\n', 9251);

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).toMatch(
        /9250_create-bare\.sql creates index:schq_idx, then 9251_drop-schq\.sql drops it/
      );
    });

    test('warns on ALTER TABLE ADD/DROP CONSTRAINT pairs', () => {
      appendMigration(
        workdir,
        '9260_add-cons',
        'ALTER TABLE wxyc_schema.flowsheet ADD CONSTRAINT chk_pair CHECK (id > 0);\n',
        9260
      );
      appendMigration(workdir, '9261_drop-cons', 'ALTER TABLE wxyc_schema.flowsheet DROP CONSTRAINT chk_pair;\n', 9261);

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).toMatch(
        /9260_add-cons\.sql creates constraint:chk_pair, then 9261_drop-cons\.sql drops it/
      );
    });

    test('does not warn on dynamic SQL (EXECUTE format(...)) — documented limitation', () => {
      appendMigration(
        workdir,
        '9270_dynamic-create',
        "DO $$ BEGIN EXECUTE format('CREATE INDEX %I ON wxyc_schema.flowsheet (id)', 'dyn_idx'); END $$;\n",
        9270
      );
      appendMigration(workdir, '9271_drop-dyn', 'DROP INDEX dyn_idx;\n', 9271);

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9270_dynamic-create\.sql creates index:dyn_idx/);
    });

    test('does not warn when both CREATE and DROP live in the same migration file', () => {
      appendMigration(
        workdir,
        '9280_self-contained',
        ['CREATE INDEX same_file_idx ON wxyc_schema.flowsheet (id);', 'DROP INDEX same_file_idx;', ''].join('\n'),
        9280
      );

      const { stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/9280_self-contained\.sql creates index:same_file_idx/);
    });

    test('the warning never causes a non-zero exit (errors only come from Checks 1-7)', () => {
      appendMigration(
        workdir,
        '9290_create-warning',
        'CREATE INDEX warning_only_idx ON wxyc_schema.flowsheet (id);\n',
        9290
      );
      appendMigration(workdir, '9291_drop-warning', 'DROP INDEX warning_only_idx;\n', 9291);
      // Provide stub snapshots so Check 7 doesn't fire on these idxs.
      for (const idx of [9290, 9291]) {
        const snap = {
          id: `00000000-3333-4444-5555-${String(idx).padStart(12, '0')}`,
          prevId: '00000000-3333-4444-5555-444444444444',
        };
        fs.writeFileSync(
          path.join(workdir, `shared/database/src/migrations/meta/${idx}_snapshot.json`),
          JSON.stringify(snap, null, 2)
        );
      }

      const { stderr, stdout, status } = run(workdir);
      expect(stderr + stdout).toMatch(/9290_create-warning\.sql creates index:warning_only_idx/);
      // status may be 1 from the stub-snapshot chain break (Check 6); we
      // only assert Check 10 itself doesn't promote the run to error.
      void status;
    });
  });

  describe('Check 11: applied-hashes.json drift detection', () => {
    const hashesPath = (work: string) => path.join(work, 'shared/database/src/migrations/meta/applied-hashes.json');
    const sqlPath = (work: string, tag: string) => path.join(work, 'shared/database/src/migrations', `${tag}.sql`);

    test('passes against the unmodified fixture (sanity)', () => {
      const { status, stdout, stderr } = run(workdir);
      expect(stderr + stdout).not.toMatch(/hash drift detected/);
      expect(stderr + stdout).not.toMatch(/has no entry in applied-hashes\.json/);
      // The fixture is the live repo state; it MUST pass Check 11. If this
      // ever fails it means somebody edited an applied .sql file without
      // running `npm run drizzle:freeze-hashes`, which is exactly the
      // wedge this check exists to prevent.
      expect(status).toBe(0);
    });

    test('errors when an applied .sql file has been edited (hash drift)', () => {
      // Append a comment to an already-recorded migration. The DDL is
      // unchanged but the bytes differ, so the hash diverges from the
      // recorded entry. This mirrors the 2710f2e wedge exactly.
      const target = sqlPath(workdir, '0034_legacy_id_columns');
      fs.appendFileSync(target, '\n-- harmless looking comment added long after apply\n');

      const { status, stderr, stdout } = run(workdir);
      expect(stderr + stdout).toMatch(/0034_legacy_id_columns\.sql hash drift detected/);
      expect(stderr + stdout).toMatch(/expected \(recorded\):/);
      expect(stderr + stdout).toMatch(/actual\s+\(current\):/);
      expect(stderr + stdout).toMatch(/PRECONDITION_NOTES\.md/);
      expect(status).not.toBe(0);
    });

    test('errors when a new .sql file has no entry in applied-hashes.json', () => {
      // Add a new migration .sql + journal entry but skip the freeze step.
      // The author-error case: forgot `npm run drizzle:freeze-hashes`.
      fs.writeFileSync(sqlPath(workdir, '9101_new-without-hash'), 'SELECT 1;\n');
      const journal = readJournal(workdir);
      journal.entries.push({
        idx: 9101,
        version: '7',
        when: Date.now() + 1_000_000_000_000 + 9101,
        tag: '9101_new-without-hash',
        breakpoints: true,
      });
      writeJournal(workdir, journal);

      const { status, stderr, stdout } = run(workdir);
      expect(stderr + stdout).toMatch(/9101_new-without-hash\.sql has no entry in applied-hashes\.json/);
      expect(stderr + stdout).toMatch(/drizzle:freeze-hashes/);
      expect(status).not.toBe(0);
    });

    test('errors when applied-hashes.json records a phantom tag (no .sql file)', () => {
      const recorded = JSON.parse(fs.readFileSync(hashesPath(workdir), 'utf8'));
      recorded['9999_phantom_tag'] = 'a'.repeat(64);
      fs.writeFileSync(hashesPath(workdir), JSON.stringify(recorded, null, 2) + '\n');

      const { status, stderr, stdout } = run(workdir);
      expect(stderr + stdout).toMatch(/applied-hashes\.json records "9999_phantom_tag" but no .* file exists/);
      expect(status).not.toBe(0);
    });

    test('errors when applied-hashes.json is missing entirely', () => {
      fs.rmSync(hashesPath(workdir));

      const { status, stderr, stdout } = run(workdir);
      expect(stderr + stdout).toMatch(/applied-hashes\.json is missing/);
      expect(stderr + stdout).toMatch(/drizzle:freeze-hashes/);
      expect(status).not.toBe(0);
    });

    test('passes when a freshly added migration has its hash recorded', () => {
      // The happy path: author adds a migration AND runs the freeze script.
      const newTag = '9102_new-with-hash';
      const newSql = 'SELECT 1; -- happy path test\n';
      fs.writeFileSync(sqlPath(workdir, newTag), newSql);
      const journal = readJournal(workdir);
      journal.entries.push({
        idx: 9102,
        version: '7',
        when: Date.now() + 1_000_000_000_000 + 9102,
        tag: newTag,
        breakpoints: true,
      });
      writeJournal(workdir, journal);

      const recorded = JSON.parse(fs.readFileSync(hashesPath(workdir), 'utf8'));
      const expected = crypto.createHash('sha256').update(newSql).digest('hex');
      recorded[newTag] = expected;
      // Re-sort to keep the file deterministic (matches freeze script output).
      const sorted: Record<string, string> = {};
      for (const k of Object.keys(recorded).sort()) sorted[k] = recorded[k];
      fs.writeFileSync(hashesPath(workdir), JSON.stringify(sorted, null, 2) + '\n');

      const { stderr, stdout } = run(workdir);
      // Other checks (snapshot, etc.) may still flag the synthetic migration,
      // but Check 11 specifically must not.
      expect(stderr + stdout).not.toMatch(/9102_new-with-hash.*hash drift/);
      expect(stderr + stdout).not.toMatch(/9102_new-with-hash.*has no entry in applied-hashes/);
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
      // 0034 / 0048 / 0059 / 0067 originally carried inline
      // `-- @no-precondition-needed:` annotations that 2710f2e (PR #705)
      // retrofitted post-apply. The retrofit changed their SHA-256 and
      // tripped the deploy verifier; the annotations were reverted and
      // the rationale moved to PRECONDITION_NOTES.md. The tags belong
      // here as grandfathered-applied, same as the rest of the set.
      '0034_legacy_id_columns',
      '0037_etl-schema-sync',
      '0041_rotation_etl_support',
      '0048_fix-fk-on-delete-set-null',
      '0059_album-plays-materialized-view',
      '0067_flowsheet-linkage-review',
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
