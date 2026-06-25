/**
 * Unit tests for `normalizeAlbumTitle`
 * (shared/database/src/normalize-album-title.ts, BS#1491 / Phase-2 Track 1).
 *
 * `normalizeAlbumTitle` is the album-leg twin of `normalizeArtistName`. It
 * exists because the free-text resolution dedup key
 * `(normalizeArtistName(artist), normalizeAlbumTitle(album))` must collapse
 * the long tail of pressing/edition variants the DJ typed into one row
 * (BS#1491). `normalizeArtistName` deliberately does NOT strip edition
 * suffixes; this function MUST, or "Pet Sounds" and "Pet Sounds (Remastered)"
 * would resolve as two distinct pairs and double-count the same logical album.
 *
 * Each case pins a transformation step. Unlike `normalizeArtistName`, this
 * function has no SQL twin yet (the Phase-2 collapse in Track 2 reads the
 * persisted `norm_album` column, it does not re-normalize in SQL), so there
 * is no cross-engine byte-identity contract to maintain — only the dedup-key
 * stability contract this table pins.
 */

import { normalizeAlbumTitle } from '../../../shared/database/src/normalize-album-title';

describe('normalizeAlbumTitle', () => {
  const cases: [string, string | null | undefined, string][] = [
    // Total over null/undefined/empty (mirrors normalizeArtistName).
    ['null input', null, ''],
    ['undefined input', undefined, ''],
    ['empty string', '', ''],
    ['whitespace-only string', '   ', ''],

    // Lowercasing + whitespace collapse + trim.
    ['plain ascii title', 'On Your Own Love Again', 'on your own love again'],
    ['mixed case', 'DOGA', 'doga'],
    ['collapses internal whitespace', 'Pet   Sounds', 'pet sounds'],
    ['trims surrounding whitespace', '  Donuts  ', 'donuts'],
    ['handles unicode', 'Csillagrablók', 'csillagrablók'],

    // Self-titled sentinels collapse to a stable token.
    ['s/t collapses to self-titled', 's/t', 'self-titled'],
    ['S/T (uppercase) collapses to self-titled', 'S/T', 'self-titled'],
    ['"self titled" collapses', 'Self Titled', 'self-titled'],
    ['"self-titled" collapses', 'Self-Titled', 'self-titled'],
    ['"selftitled" collapses', 'selftitled', 'self-titled'],

    // & <-> and canonicalization (pick one form so both inputs collapse).
    ['ampersand becomes "and"', 'Duke Ellington & John Coltrane', 'duke ellington and john coltrane'],
    ['the word "and" is preserved', 'Songs and Stories', 'songs and stories'],

    // Featuring clauses are dropped (album titles rarely carry them, but
    // free-text the DJ typed can).
    ['drops "feat." clause', 'Edits feat. Some Guest', 'edits'],
    ['drops "featuring" clause', 'DAMN. featuring Laraaji', 'damn.'],
    ['drops "ft." clause', 'Donuts ft. J Dilla', 'donuts'],
    ['drops parenthetical "(feat. X)" clause', 'Call Your Name (feat. Guest)', 'call your name'],

    // The featuring strip must only fire on a real marker (the full word
    // "featuring", or the abbreviations with a period), never on a bare "ft"/
    // "feat" that is itself a content word — otherwise real titles get
    // truncated and collide. "10 Ft Ganja Plant" is a real WXYC-played act.
    ['preserves a standalone "Ft" content word', '10 Ft Ganja Plant', '10 ft ganja plant'],
    ['preserves a trailing real "Feat" word', 'A Great Feat', 'a great feat'],

    // Edition / remaster parentheticals are stripped (the core reason this
    // function exists; normalizeArtistName does NOT do this).
    ['strips "(Remaster)"', 'Pet Sounds (Remaster)', 'pet sounds'],
    ['strips "(Remastered)"', 'Pet Sounds (Remastered)', 'pet sounds'],
    ['strips "(2011 Remaster)"', 'Pet Sounds (2011 Remaster)', 'pet sounds'],
    ['strips "(Deluxe Edition)"', 'On Your Own Love Again (Deluxe Edition)', 'on your own love again'],
    ['strips "(Expanded Edition)"', 'DAMN. (Expanded Edition)', 'damn.'],
    ['strips "(Anniversary Edition)"', 'Donuts (10th Anniversary Edition)', 'donuts'],
    ['strips "[Remastered]" brackets', 'Pet Sounds [Remastered]', 'pet sounds'],
    ['strips trailing "- Remastered"', 'Pet Sounds - Remastered', 'pet sounds'],
    ['strips trailing "- 2011 Remaster"', 'Pet Sounds - 2011 Remaster', 'pet sounds'],
    ['strips "(Mono)"', 'Pet Sounds (Mono)', 'pet sounds'],
    ['strips "(Stereo)"', 'Pet Sounds (Stereo)', 'pet sounds'],
    ['strips "(Original Motion Picture Soundtrack)"', 'DAMN. (Original Motion Picture Soundtrack)', 'damn.'],
    ['strips multiple parentheticals', 'Pet Sounds (Deluxe Edition) (Remastered)', 'pet sounds'],
    ['preserves a non-edition parenthetical', 'DOGA (Live)', 'doga (live)'],

    // Edition keywords must match as WHOLE WORDS, not substrings — otherwise a
    // non-edition clause containing "ost"/"mono"/"stereo" etc. as a substring
    // (lost, ghost, monologue, stereotype) is wrongly stripped and two
    // genuinely distinct albums collapse into one dedup key.
    ['preserves "(Lost Tapes)" — "ost" is not a whole word', 'Donuts (Lost Tapes)', 'donuts (lost tapes)'],
    ['preserves "(Monologue)" — "mono" is not a whole word', 'Edits (Monologue)', 'edits (monologue)'],
    ['preserves a non-edition trailing "- Lost Sessions"', 'Donuts - Lost Sessions', 'donuts - lost sessions'],

    // Common abbreviations expanded so typed variants collapse together.
    ['expands leading "Vol." to volume', 'Vol. 1', 'volume 1'],
    ['expands "Pt." to part', 'Donuts Pt. 2', 'donuts part 2'],
    ['expands "&" inside title', 'Rock & Roll', 'rock and roll'],

    // Idempotence: running an already-normalized title is a no-op.
    ['is idempotent', 'pet sounds', 'pet sounds'],
  ];

  it.each(cases)('%s: %j → %j', (_label, input, expected) => {
    expect(normalizeAlbumTitle(input)).toBe(expected);
  });
});
