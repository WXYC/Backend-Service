import {
  COMMA_SPLIT,
  CO_BILL_DELIMITER,
  SPACED_SLASH,
  SUPPORT_PLACEHOLDER,
  W_JOINER,
  normalizeFreetextArtist,
} from '@wxyc/database/support-list';
import { SUPPORT_TAIL, TAIL_SPLIT } from '../../../../jobs/triangle-shows-etl/headliner';

describe('W_JOINER', () => {
  test.each([
    ['w/ Cannons', 'Cannons'],
    ['W/Cannons', 'Cannons'],
    ['w/o Cannons', null],
    ['w/out Cannons', null],
    ['with Cannons', null],
  ])('%j strips to %j', (input, rest) => {
    const m = W_JOINER.exec(input);
    expect(m === null ? null : input.slice(m[0].length)).toBe(rest);
  });

  // The billing-tail regexes stay literals (security/detect-non-literal-regexp),
  // so the one lookahead is pinned by source equality instead of composition.
  test('headliner.ts composed regexes carry the same lookahead', () => {
    const fragment = W_JOINER.source.slice(1, W_JOINER.source.indexOf('\\s*'));
    expect(fragment).toBe('w\\/(?!o(?:ut)?\\b)');
    expect(SUPPORT_TAIL.source).toContain(fragment);
    expect(TAIL_SPLIT.source).toContain(fragment);
  });
});

describe('SUPPORT_PLACEHOLDER (raw name or already-normalized key)', () => {
  test.each([
    ['special guests', true],
    ['Very Special Guest', true],
    ['& More', true],
    ['and friends', true],
    ['TBA', true],
    ['tbd', true],
    ['guests', true],
    ['The Cannons', false],
    ['More Than Life', false],
    ['friends of dean', false],
  ])('%j -> %j', (input, expected) => {
    expect(SUPPORT_PLACEHOLDER.test(input)).toBe(expected);
    expect(SUPPORT_PLACEHOLDER.test(normalizeFreetextArtist(input))).toBe(expected);
  });
});

describe('list delimiters', () => {
  test('COMMA_SPLIT takes an Oxford and/&', () => {
    expect('A, B, and C, & D'.split(COMMA_SPLIT)).toEqual(['A', 'B', 'C', 'D']);
  });
  test('SPACED_SLASH needs whitespace on both sides', () => {
    expect('AC/DC / Mudhoney'.split(SPACED_SLASH)).toEqual(['AC/DC', 'Mudhoney']);
  });
  test('SPACED_SLASH agrees with the read-path co-bill slash', () => {
    expect(SPACED_SLASH.source).toBe('\\s+\\/\\s+');
    expect(CO_BILL_DELIMITER.test('A / B')).toBe(true);
  });
});
