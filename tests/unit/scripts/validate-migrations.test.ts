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
    // The latest snapshot's prevId points at 0046's id. Replace 0055's
    // prevId with a UUID that doesn't exist in any snapshot.
    const latestPath = path.join(workdir, 'shared/database/src/migrations/meta/0055_snapshot.json');
    const snap = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    snap.prevId = '00000000-1111-2222-3333-444444444444';
    fs.writeFileSync(latestPath, JSON.stringify(snap, null, 2));

    const { status, stderr } = run(workdir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/prevId .* not found in any snapshot/);
  });
});
