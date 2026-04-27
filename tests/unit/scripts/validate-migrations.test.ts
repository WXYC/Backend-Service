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
});
