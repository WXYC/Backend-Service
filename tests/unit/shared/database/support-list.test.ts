import {
  COMMA_SPLIT,
  CO_BILL_DELIMITER,
  SPACED_SLASH,
  SUPPORT_PLACEHOLDER,
  W_JOINER,
  normalizeFreetextArtist,
} from '@wxyc/database/support-list';
import { SUPPORT_TAIL, TAIL_SPLIT } from '../../../../jobs/triangle-shows-etl/headliner';
import { SUBHEADER_LEAD_IN, SUBHEADER_SPLIT } from '../../../../jobs/venue-events-scraper/parse';

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
});

// Callers that embed a shared rule mid-pattern keep a literal
// (security/detect-non-literal-regexp forbids building one from `.source`),
// so each literal is pinned here: source and flags, with the shared parts
// interpolated. Editing any of these literals means editing its pin, which is
// the point — the shared part cannot drift in one copy only.
describe('embedded copies of the shared rules', () => {
  // W_JOINER without its anchor and trailing whitespace: the bare `w/` token.
  const W = String.raw`w\/(?!o(?:ut)?\b)`;

  test('W_JOINER is the anchored `w/` token plus optional whitespace', () => {
    expect(W_JOINER.source).toBe(String.raw`^${W}\s*`);
  });

  test.each([
    [
      'headliner.ts SUPPORT_TAIL',
      SUPPORT_TAIL,
      String.raw`\s+(?:${W}|\/\/)\s*\S.*$|\s+(?:feat\.|ft\.|featuring)\s+\S.*$`,
      'i',
    ],
    [
      'headliner.ts TAIL_SPLIT',
      TAIL_SPLIT,
      String.raw`\s*,\s*|\s+(?:${W}|\/\/)\s*|${SPACED_SLASH.source}|\s+(?:feat\.|ft\.|featuring)\s+`,
      'gi',
    ],
    // One alternation, not COMMA_SPLIT then SPACED_SLASH: the split result
    // depends on it (`A / , B`).
    ['parse.ts SUBHEADER_SPLIT', SUBHEADER_SPLIT, `${COMMA_SPLIT.source}|${SPACED_SLASH.source}`, ''],
  ])('%s is pinned to the shared parts', (_name, regex, source, flags) => {
    expect(regex.source).toBe(source);
    expect(regex.flags).toBe(flags);
  });

  // `w/` is the LAST lead-in alternative, so it applies only when no other
  // lead-in matched; the other alternatives are the scraper's own.
  test('parse.ts SUBHEADER_LEAD_IN ends with W_JOINER as its last alternative', () => {
    expect(SUBHEADER_LEAD_IN.source.endsWith(`|${W_JOINER.source}`)).toBe(true);
    expect(SUBHEADER_LEAD_IN.flags).toBe(W_JOINER.flags);
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
