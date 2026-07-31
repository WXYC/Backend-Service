/**
 * Unit tests for flowsheet-ghost-row-sweep's LegacyKeyspaceSource seam.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseIdFile, FileKeyspaceSource } from '../../../../jobs/flowsheet-ghost-row-sweep/keyspace-source';

describe('parseIdFile', () => {
  it('parses newline-delimited integers into a Set', () => {
    expect(parseIdFile('1\n2\n3\n', 'test')).toEqual(new Set([1, 2, 3]));
  });

  it('skips blank lines and #-prefixed comments', () => {
    expect(parseIdFile('1\n\n# comment\n2\n', 'test')).toEqual(new Set([1, 2]));
  });

  it('dedupes repeated ids', () => {
    expect(parseIdFile('1\n1\n2\n', 'test')).toEqual(new Set([1, 2]));
  });

  it('throws with a source:line context on a non-integer line', () => {
    expect(() => parseIdFile('1\nnot-an-id\n2\n', 'fixture.txt')).toThrow(/fixture\.txt:2/);
  });
});

describe('FileKeyspaceSource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ghost-row-sweep-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads each table id set from its own file', async () => {
    const flowsheetPath = join(dir, 'flowsheet-ids.txt');
    const rotationPath = join(dir, 'rotation-ids.txt');
    await writeFile(flowsheetPath, '10\n20\n30\n');
    await writeFile(rotationPath, '99\n');

    const source = new FileKeyspaceSource(flowsheetPath, rotationPath);

    await expect(source.loadFlowsheetIds()).resolves.toEqual(new Set([10, 20, 30]));
    await expect(source.loadRotationIds()).resolves.toEqual(new Set([99]));
  });

  it('rejects when a configured file is missing', async () => {
    const source = new FileKeyspaceSource(join(dir, 'missing.txt'), join(dir, 'also-missing.txt'));
    await expect(source.loadFlowsheetIds()).rejects.toThrow();
  });
});
