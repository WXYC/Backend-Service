import { epochMsToDate, truncate, parseTabRow, toNullable } from '@wxyc/database';

describe('epochMsToDate', () => {
  it('converts valid epoch ms to Date', () => {
    const date = epochMsToDate(1706788800000);
    expect(date).toBeInstanceOf(Date);
    expect(date?.toISOString()).toBe('2024-02-01T12:00:00.000Z');
  });

  it('returns null for 0', () => {
    expect(epochMsToDate(0)).toBeNull();
  });

  it('returns null for null', () => {
    expect(epochMsToDate(null)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(epochMsToDate(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(epochMsToDate(Infinity)).toBeNull();
  });
});

describe('truncate', () => {
  it('returns string unchanged when within limit', () => {
    expect(truncate('hello', 128)).toBe('hello');
  });

  it('truncates string exceeding limit', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde');
  });

  it('trims whitespace', () => {
    expect(truncate('  hello  ', 128)).toBe('hello');
  });

  it('returns null for null input', () => {
    expect(truncate(null, 128)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(truncate(undefined, 128)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(truncate('', 128)).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(truncate('   ', 128)).toBeNull();
  });
});

describe('parseTabRow', () => {
  it('splits tab-separated values when column count matches', () => {
    expect(parseTabRow('a\tb\tc', 3)).toEqual(['a', 'b', 'c']);
  });

  it('returns null when column count does not match', () => {
    expect(parseTabRow('a\tb', 3)).toBeNull();
  });

  it('handles empty columns', () => {
    expect(parseTabRow('\t\t', 3)).toEqual(['', '', '']);
  });
});

describe('toNullable', () => {
  it('returns trimmed value for non-empty string', () => {
    expect(toNullable('hello')).toBe('hello');
  });

  it('trims whitespace', () => {
    expect(toNullable('  hello  ')).toBe('hello');
  });

  it('returns null for empty string', () => {
    expect(toNullable('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(toNullable('   ')).toBeNull();
  });

  it('returns null for "NULL" string', () => {
    expect(toNullable('NULL')).toBeNull();
  });
});
