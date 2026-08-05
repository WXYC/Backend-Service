/**
 * Unit tests for jobs/flowsheet-metadata-backfill/env-int.ts (BS#1995 review
 * follow-up S1+S2): the shared `Number()`-based, warn-and-fallback env-int
 * parser extracted out of the four near-duplicate copies that used to live
 * in lml-fetch.ts, lml-limiter.ts, and lml-health.ts (logger.ts's
 * `resolveTracesSampleRate` is a different beast — a bounded float parser,
 * not an integer parser — and is deliberately NOT folded in here; see the
 * PR discussion).
 *
 * S1's bug: the pre-extraction copies accepted whitespace-only ('
 * '), decimals (2.5), and hex (0x10) despite being named `envInt`. A stray
 * trailing space in an `--env-file` line silently produced 0, which for a
 * non-negative-bounded knob like the breaker gate's interval meant "gate
 * disabled" with no warning at all.
 */
import { parseEnvInt } from '../../../../jobs/flowsheet-metadata-backfill/env-int';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const warnMessage = (raw: string) => `test: FOO=${raw} is invalid; using fallback 42`;

describe('parseEnvInt', () => {
  it('returns the fallback when unset', () => {
    delete process.env.FOO;
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
  });

  it('returns the fallback when set to the empty string', () => {
    process.env.FOO = '';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
  });

  it('parses a valid positive integer', () => {
    process.env.FOO = '20';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(20);
  });

  it('positive bound rejects 0 (with warning)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '0';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalledWith('test: FOO=0 is invalid; using fallback 42');
    warn.mockRestore();
  });

  it('non-negative bound accepts 0 silently (no warning)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '0';
    expect(parseEnvInt('FOO', 42, 'non-negative', warnMessage)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects a negative value under either bound', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '-5';
    expect(parseEnvInt('FOO', 42, 'non-negative', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects partial-parse garbage like "20banana" (no silent coercion)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '20banana';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalledWith('test: FOO=20banana is invalid; using fallback 42');
    warn.mockRestore();
  });

  // S1: the actual bug this extraction fixes.
  it('S1: rejects whitespace-only, with a warning (the silent-disable bug)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '   ';
    expect(parseEnvInt('FOO', 42, 'non-negative', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('S1: rejects a tab/newline-only value, with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '\t\n';
    expect(parseEnvInt('FOO', 42, 'non-negative', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('S1: rejects a decimal like "2.5" (Number.isInteger semantics), with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '2.5';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('S1: rejects hex notation like "0x10", with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '0x10';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('S1: rejects scientific notation like "1e3", with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '1e3';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('trims surrounding whitespace on an otherwise-valid value', () => {
    process.env.FOO = '  20  ';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(20);
  });

  it('accepts a leading-minus negative literal shape but still rejects it on the bound check', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FOO = '-1';
    expect(parseEnvInt('FOO', 42, 'positive', warnMessage)).toBe(42);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('passes the raw (untrimmed) value to the warning builder for an accurate error message', () => {
    const seen: string[] = [];
    process.env.FOO = '  bad  ';
    parseEnvInt('FOO', 42, 'positive', (raw) => {
      seen.push(raw);
      return 'warned';
    });
    expect(seen).toEqual(['  bad  ']);
  });
});
