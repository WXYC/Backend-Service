/**
 * Unit tests for uncovered-release-list's writer.ts (BS#1877): the locked
 * `uncovered-releases.jsonl` wire schema (coordinated with
 * `WXYC/research-data#16`) and the local file write. No DB involved — pure
 * rendering plus real filesystem calls against a per-test temp path (no
 * mocking needed for `node:fs/promises`).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderSnapshot,
  toSnapshotRow,
  resolveOutputPath,
  writeSnapshotFile,
} from '../../../../jobs/uncovered-release-list/writer';
import type { CanonicalRelease } from '../../../../jobs/uncovered-release-list/rotation';

describe('toSnapshotRow / renderSnapshot', () => {
  it('renders the locked {artist, album, library_id} schema, one JSON object per line, key order preserved', () => {
    const releases: CanonicalRelease[] = [
      { libraryId: 42, artist: 'Tony Allen', album: 'What goes up' },
      { libraryId: 99, artist: 'Setting', album: 'Setting' },
    ];

    const content = renderSnapshot(releases);
    const lines = content.split('\n').filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ artist: 'Tony Allen', album: 'What goes up', library_id: 42 });
    // Key order matters for the locked-schema contract's readability, not just its parsed equality.
    expect(lines[0]).toBe(JSON.stringify({ artist: 'Tony Allen', album: 'What goes up', library_id: 42 }));
    expect(JSON.parse(lines[1])).toEqual({ artist: 'Setting', album: 'Setting', library_id: 99 });
  });

  it('ends with a single trailing newline for a non-empty snapshot', () => {
    const content = renderSnapshot([{ libraryId: 1, artist: 'A', album: 'B' }]);
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
  });

  it('renders an empty string (not a blank line) for zero releases', () => {
    expect(renderSnapshot([])).toBe('');
  });

  it('toSnapshotRow maps CanonicalRelease.libraryId to the wire key library_id', () => {
    expect(toSnapshotRow({ libraryId: 7, artist: 'X', album: 'Y' })).toEqual({
      artist: 'X',
      album: 'Y',
      library_id: 7,
    });
  });
});

describe('resolveOutputPath', () => {
  it('defaults to ./output/uncovered-releases.jsonl when unset', () => {
    expect(resolveOutputPath(undefined)).toBe('./output/uncovered-releases.jsonl');
  });

  it('trims and honors an explicit OUTPUT_PATH', () => {
    expect(resolveOutputPath('  /tmp/foo.jsonl  ')).toBe('/tmp/foo.jsonl');
  });

  it('falls back to the default for an empty/whitespace-only override', () => {
    expect(resolveOutputPath('   ')).toBe('./output/uncovered-releases.jsonl');
  });
});

describe('writeSnapshotFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'uncovered-release-list-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates parent directories as needed and writes the exact content given', async () => {
    const path = join(dir, 'nested', 'uncovered-releases.jsonl');
    const content = renderSnapshot([{ libraryId: 1, artist: 'A', album: 'B' }]);

    const result = await writeSnapshotFile(content, path);

    expect(result).toEqual({ path });
    expect(await readFile(path, 'utf8')).toBe(content);
  });

  it('overwrites an existing file in place (idempotent re-run)', async () => {
    const path = join(dir, 'uncovered-releases.jsonl');
    await writeSnapshotFile('stale content\n', path);
    await writeSnapshotFile('fresh content\n', path);
    expect(await readFile(path, 'utf8')).toBe('fresh content\n');
  });
});
