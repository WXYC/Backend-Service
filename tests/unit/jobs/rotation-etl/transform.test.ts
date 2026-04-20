import { mapRotationType, epochMsToDateString } from '../../../../jobs/rotation-etl/transform';

describe('mapRotationType', () => {
  it.each([
    ['H', 'H'],
    ['M', 'M'],
    ['L', 'L'],
    ['S', 'S'],
    ['N', 'N'],
  ] as const)('maps "%s" to "%s"', (input, expected) => {
    expect(mapRotationType(input)).toBe(expected);
  });

  it('normalizes lowercase to uppercase', () => {
    expect(mapRotationType('h')).toBe('H');
    expect(mapRotationType('m')).toBe('M');
  });

  it('trims whitespace', () => {
    expect(mapRotationType(' H ')).toBe('H');
  });

  it('defaults unknown types to N', () => {
    expect(mapRotationType('X')).toBe('N');
    expect(mapRotationType('')).toBe('N');
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
