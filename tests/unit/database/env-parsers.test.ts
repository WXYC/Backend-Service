import { requireNonNegativeInt, requirePositiveInt } from '../../../shared/database/src/env-parsers';

describe('requirePositiveInt', () => {
  it('returns fallback when raw is undefined, empty, or whitespace-only', () => {
    expect(requirePositiveInt(undefined, 'X', 42)).toBe(42);
    expect(requirePositiveInt('', 'X', 42)).toBe(42);
    expect(requirePositiveInt('   ', 'X', 42)).toBe(42);
    expect(requirePositiveInt('\t\n', 'X', 42)).toBe(42);
  });

  it('returns the parsed integer when valid', () => {
    expect(requirePositiveInt('1', 'X', 42)).toBe(1);
    expect(requirePositiveInt('100', 'X', 42)).toBe(100);
  });

  it('throws on zero, negative, non-integer, or non-numeric input', () => {
    expect(() => requirePositiveInt('0', 'X', 42)).toThrow(/X.*positive integer/);
    expect(() => requirePositiveInt('-1', 'X', 42)).toThrow(/X.*positive integer/);
    expect(() => requirePositiveInt('1.5', 'X', 42)).toThrow(/X.*positive integer/);
    expect(() => requirePositiveInt('abc', 'X', 42)).toThrow(/X.*positive integer/);
    expect(() => requirePositiveInt('Infinity', 'X', 42)).toThrow(/X.*positive integer/);
  });
});

describe('requireNonNegativeInt', () => {
  it('returns fallback when raw is undefined, empty, or whitespace-only', () => {
    expect(requireNonNegativeInt(undefined, 'X', 42)).toBe(42);
    expect(requireNonNegativeInt('', 'X', 42)).toBe(42);
    expect(requireNonNegativeInt('   ', 'X', 42)).toBe(42);
    expect(requireNonNegativeInt('\t\n', 'X', 42)).toBe(42);
  });

  it('returns the parsed integer when valid (including zero)', () => {
    expect(requireNonNegativeInt('0', 'X', 42)).toBe(0);
    expect(requireNonNegativeInt('1', 'X', 42)).toBe(1);
    expect(requireNonNegativeInt('100', 'X', 42)).toBe(100);
  });

  it('throws on negative, non-integer, or non-numeric input', () => {
    expect(() => requireNonNegativeInt('-1', 'X', 42)).toThrow(/X.*non-negative integer/);
    expect(() => requireNonNegativeInt('1.5', 'X', 42)).toThrow(/X.*non-negative integer/);
    expect(() => requireNonNegativeInt('abc', 'X', 42)).toThrow(/X.*non-negative integer/);
    expect(() => requireNonNegativeInt('Infinity', 'X', 42)).toThrow(/X.*non-negative integer/);
  });
});

describe('error formatting options', () => {
  it('prepends bracketed context when provided', () => {
    expect(() => requirePositiveInt('0', 'X', 42, { context: 'my-job' })).toThrow(
      /^\[my-job\] Invalid X="0": must be a positive integer\.$/
    );
  });

  it('appends parenthesized unit when provided', () => {
    expect(() => requireNonNegativeInt('-1', 'PAUSE', 30, { unit: 'ms' })).toThrow(
      /Invalid PAUSE="-1": must be a non-negative integer \(ms\)\.$/
    );
  });

  it('appends trailing note when provided', () => {
    expect(() => requireNonNegativeInt('-1', 'LOOKBACK', 60, { unit: 's', note: 'Use 0 to disable.' })).toThrow(
      /Invalid LOOKBACK="-1": must be a non-negative integer \(s\)\. Use 0 to disable\.$/
    );
  });

  it('JSON-stringifies the raw value in the error message', () => {
    expect(() => requirePositiveInt('not-a-number', 'X', 1)).toThrow(/X="not-a-number"/);
  });
});
