jest.mock('@wxyc/database', () => ({
  MirrorSQL: {
    instance: jest.fn().mockReturnValue({
      send: jest.fn(),
      close: jest.fn(),
    }),
  },
  parseTabRow: (line: string, columnCount: number) => {
    const columns = line.split('\t');
    return columns.length === columnCount ? columns : null;
  },
  toNullable: (value: string) => {
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed === 'NULL' ? null : trimmed;
  },
}));

import { parseRotationRows } from '../../../../jobs/rotation-etl/fetch-legacy';

describe('parseRotationRows', () => {
  it('parses a valid 9-column tab-separated row', () => {
    const raw = '42\tAutechre\tConfield\tH\tWarp\t1706788800000\t0\t101\t1706800000000';
    const rows = parseRotationRows(raw);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 42,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      rotationType: 'H',
      labelName: 'Warp',
      addDate: 1706788800000,
      killDate: 0,
      libraryReleaseId: 101,
      timeLastModified: 1706800000000,
    });
  });

  it('returns empty array for empty input', () => {
    expect(parseRotationRows('')).toEqual([]);
    expect(parseRotationRows('  \n  ')).toEqual([]);
  });

  it('treats LIBRARY_RELEASE_ID of 0 as null', () => {
    const raw = '42\tAutechre\tConfield\tH\tWarp\t1706788800000\t0\t0\t1706800000000';
    const rows = parseRotationRows(raw);

    expect(rows[0].libraryReleaseId).toBeNull();
  });

  it('treats empty artist name as null', () => {
    const raw = '42\t\tConfield\tN\tWarp\t1706788800000\t0\t0\t1706800000000';
    const rows = parseRotationRows(raw);

    expect(rows[0].artistName).toBeNull();
  });

  it('treats NULL string values as null', () => {
    const raw = '42\tNULL\tNULL\tN\tNULL\t1706788800000\t0\t0\t1706800000000';
    const rows = parseRotationRows(raw);

    expect(rows[0].artistName).toBeNull();
    expect(rows[0].albumTitle).toBeNull();
    expect(rows[0].labelName).toBeNull();
  });

  it('skips malformed rows with wrong column count', () => {
    const raw = '42\tAutechre\tConfield\tH\tWarp';
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    const rows = parseRotationRows(raw);

    expect(rows).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('parses multiple rows', () => {
    const raw = [
      '42\tAutechre\tConfield\tH\tWarp\t1706788800000\t0\t101\t1706800000000',
      '43\tStereolab\tAluminum Tunes\tM\tDuophonic\t1706788800000\t1707000000000\t0\t1707000000000',
    ].join('\n');

    const rows = parseRotationRows(raw);

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(42);
    expect(rows[1].id).toBe(43);
    expect(rows[1].killDate).toBe(1707000000000);
    expect(rows[1].libraryReleaseId).toBeNull();
  });

  it('defaults empty rotationType to N', () => {
    const raw = '42\tAutechre\tConfield\t\tWarp\t1706788800000\t0\t0\t1706800000000';
    const rows = parseRotationRows(raw);

    expect(rows[0].rotationType).toBe('N');
  });
});
