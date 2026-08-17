import { parseRotationBin, epochMsToDateString } from '../../../../jobs/rotation-etl/transform';

describe('parseRotationBin', () => {
  it.each([
    ['H', 'H'],
    ['M', 'M'],
    ['L', 'L'],
    ['S', 'S'],
    ['h', 'H'],
    [' H ', 'H'],
  ] as const)('parses %p as the bin %p', (input, expected) => {
    expect(parseRotationBin(input)).toEqual({ kind: 'bin', bin: expected });
  });

  // Blank is a legitimate upstream state; the caller skips it quietly.
  it.each([[''], ['  '], [null], [undefined]])('classifies %p as missing', (input) => {
    expect(parseRotationBin(input)).toEqual({ kind: 'missing' });
  });

  // Bad data, kept distinct from missing so the caller can warn on it. 'N' is
  // pinned by name (BS#2173) so re-adding it has to delete a named case.
  it.each([['X'], ['N'], ['new']])('classifies %p as invalid', (input) => {
    expect(parseRotationBin(input)).toEqual({ kind: 'invalid', raw: input });
  });
});

describe('epochMsToDateString', () => {
  it('converts epoch ms to YYYY-MM-DD', () => {
    // 2024-02-01T12:00:00.000Z
    expect(epochMsToDateString(1706788800000)).toBe('2024-02-01');
  });

  it('returns null for 0 (tubafrenzy not-set sentinel)', () => {
    expect(epochMsToDateString(0)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(epochMsToDateString(NaN)).toBeNull();
  });

  it('handles negative epoch ms (dates before 1970)', () => {
    expect(epochMsToDateString(-86400000)).toBe('1969-12-31');
  });
});
