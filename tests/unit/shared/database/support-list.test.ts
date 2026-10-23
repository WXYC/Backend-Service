import {
  COMMA_SPLIT,
  CO_BILL_DELIMITER,
  SPACED_SLASH,
  SUPPORT_PLACEHOLDER,
  W_JOINER,
  normalizeFreetextArtist,
} from '@wxyc/database/support-list';
import { SUPPORT_TAIL, TAIL_SPLIT } from '../../../../jobs/triangle-shows-etl/headliner';
import { SUBHEADER_SPLIT } from '../../../../jobs/venue-events-scraper/parse';

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

  // The comma and spaced-slash rules are embedded mid-pattern in single
  // alternations whose split results depend on being one regex (`A / , B`),
  // so those literals are pinned to the shared parts by source equality.
  test('parse.ts SUBHEADER_SPLIT is exactly COMMA_SPLIT | SPACED_SLASH', () => {
    expect(SUBHEADER_SPLIT.source).toBe(`${COMMA_SPLIT.source}|${SPACED_SLASH.source}`);
  });
  test('headliner.ts TAIL_SPLIT carries SPACED_SLASH as one of its alternatives', () => {
    expect(TAIL_SPLIT.source.split('|')).toContain(SPACED_SLASH.source);
  });

  // SPACED_SLASH (`\s+\/\s+`) and the read-path CO_BILL_DELIMITER slash
  // (`\s\/\s`, the same literal as BILLING_DELIMITER_PATTERNS.slash, which
  // map.ts splits on) are different rules today: they detect the same
  // co-bills but split a doubled slash differently. Unifying them is BS#3682.
  test.each([
    ['A / B', true],
    ['A\t/\tB', true],
    ['A  /  B', true],
    ['AC/DC', false],
    ['A /B', false],
    ['A/ B', false],
  ])('SPACED_SLASH and CO_BILL_DELIMITER both detect a spaced slash in %j -> %j', (input, expected) => {
    expect(SPACED_SLASH.test(input)).toBe(expected);
    expect(CO_BILL_DELIMITER.test(input)).toBe(expected);
  });
  test('SPACED_SLASH and CO_BILL_DELIMITER split a doubled slash differently', () => {
    expect('A /  / B'.split(SPACED_SLASH)).toEqual(['A', '/ B']);
    expect('A /  / B'.split(CO_BILL_DELIMITER)).toEqual(['A', '', 'B']);
  });
});
