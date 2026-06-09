/**
 * Unit tests for `normalizeArtistName` (BS#1372 / shared/database/src/normalize-artist-name.ts).
 *
 * This TypeScript twin must produce byte-identical output to the SQL
 * function `wxyc_schema.normalize_artist_name(text)` defined in migration
 * 0092 — the concerts-artist-resolver compares results across SQL and JS
 * call sites, and any drift between them surfaces as silent NULL
 * `headlining_artist_id` values that look like no-match but are actually
 * mismatch-on-normalization. Each case here is paired with the SQL
 * function's behavior; if the JS test changes shape, the migration must
 * change to match.
 */

import { normalizeArtistName } from '../../../shared/database/src/normalize-artist-name';

describe('normalizeArtistName', () => {
  const cases: [string, string | null | undefined, string][] = [
    ['null input', null, ''],
    ['undefined input', undefined, ''],
    ['empty string', '', ''],
    ['plain ascii name', 'Pavement', 'pavement'],
    ['mixed case', 'JESSICA Pratt', 'jessica pratt'],
    ['strips leading "The "', 'The Beatles', 'beatles'],
    ['strips leading "the " (lowercase)', 'the beatles', 'beatles'],
    ['strips leading "THE " (uppercase)', 'THE BEATLES', 'beatles'],
    ['strips "The" with multiple spaces', 'The   Beatles', 'beatles'],
    ['strips "The" with tab', 'The\tBeatles', 'beatles'],
    ['does NOT strip inner "the"', 'Here Comes The Sun', 'here comes the sun'],
    ['does NOT strip "There"', 'There Will Be Fireworks', 'there will be fireworks'],
    ['does NOT strip "Them"', 'Them Crooked Vultures', 'them crooked vultures'],
    ['does NOT strip "the" with no separator', 'theBeatles', 'thebeatles'],
    ['preserves trailing whitespace', 'Pavement ', 'pavement '],
    ['handles unicode (Björk)', 'Björk', 'björk'],
    ['handles ampersand', 'Simon & Garfunkel', 'simon & garfunkel'],
    ['handles slash', 'AC/DC', 'ac/dc'],
    // The separator class is intentionally narrow — POSIX [ \t\n\r\f\v] —
    // so the JS twin matches the PG ARE `\s` (ASCII-only) byte-for-byte.
    // These cases pin the LIMITATION as part of the contract: NBSP /
    // narrow no-break / line/paragraph separators do NOT count as
    // "The " separators in either engine. The venue-events scraper
    // converts `&nbsp;` to ASCII space upstream, so this gap is
    // not reached in production today.
    ['does NOT strip "The" with NBSP (U+00A0)', 'The Beatles', 'the beatles'],
    ['does NOT strip "The" with narrow no-break (U+202F)', 'The Beatles', 'the beatles'],
    ['does NOT strip "The" with line separator (U+2028)', 'The Beatles', 'the beatles'],
  ];

  it.each(cases)('%s: %j → %j', (_label, input, expected) => {
    expect(normalizeArtistName(input)).toBe(expected);
  });
});
