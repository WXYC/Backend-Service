/**
 * Unit tests for the clean-name LML gate (BS#1614 PR 1).
 *
 * `isCleanHeadliner` decides which stored headliner names are eligible for
 * the LML#759 bare-name resolve pass. It is an API-BUDGET gate, not a
 * correctness gate: under LML's verify-before-mint design a co-bill string
 * can't exact-form-match a Discogs artist, so a dirty name that slips
 * through wastes one Discogs call and lands `not_found` — while a clean
 * name wrongly gated just stays unresolved (status quo). Both failure
 * modes are cheap, which is why the gate can be simpler than the
 * extractor.
 *
 * The extraction suite for `extractHeadliner` itself lives in map.test.ts
 * (imported through map.ts's re-export, which doubles as the re-export
 * regression test).
 */
import {
  BILLING_DELIMITER_PATTERNS,
  HARD_BILLING_DELIMITERS,
  extractHeadliner,
  isCleanHeadliner,
} from '../../../../jobs/triangle-shows-etl/headliner';

describe('HARD_BILLING_DELIMITERS', () => {
  it('is exactly the union of BILLING_DELIMITER_PATTERNS (literal pinned against the record)', () => {
    // The union is a literal regex (security/detect-non-literal-regexp);
    // this pin is what keeps it and the per-reason record from drifting.
    const derived = Object.values(BILLING_DELIMITER_PATTERNS)
      .map((pattern) => pattern.source)
      .join('|');
    expect(HARD_BILLING_DELIMITERS.source).toBe(derived);
    expect(HARD_BILLING_DELIMITERS.flags).toBe('i');
  });
});

describe('isCleanHeadliner — clean single-artist names pass', () => {
  it.each([
    // The BS#1614 prod residual's sample population — the exact names the
    // gate exists to let through.
    'Wishy',
    "L'Rain",
    'REZN',
    'glaive',
    'The Tubs',
    'SiM',
    'Popsicle',
    // `&` / `and` are NOT billing delimiters: the BS#1613 prod-sample
    // analysis found that bucket dominated by real single acts, and under
    // verify-before-mint a genuine `&` co-bill just returns not_found.
    'AJ Lee & Blue Summit',
    'Nick Cave and the Bad Seeds',
    'Duke Ellington & John Coltrane',
    'Iron and Wine',
    '...And You Will Know Us by the Trail of Dead',
    // Shapes the extractor deliberately preserves stay clean.
    '(Sandy) Alex G',
    '!!! (Chk Chk Chk)',
    'Owen (solo)',
    'Godspeed You! Black Emperor',
    // Slash / `with` / `w/o` only count with the delimiter's exact spacing.
    'AC/DC',
    'DIIV/Horsegirl',
    'Angel w/o Wings',
    'With Honor',
    'Withered Hand',
  ])('isCleanHeadliner(%j) === true', (name) => {
    expect(isCleanHeadliner(name)).toBe(true);
  });
});

describe('isCleanHeadliner — hard billing delimiters gate', () => {
  it.each([
    // Comma anywhere.
    ['Wishy, special guest TBA', 'comma'],
    ['Built to Spill, Prism Bitch, Itchy Kitty', 'comma'],
    // Space-delimited ` + `.
    ['Sylvan Esso + Flock of Dimes', 'plus'],
    // Space-delimited ` / ` (AC/DC-style names have no spaces and pass).
    ['Magic City Hippies / Flipturn', 'slash'],
    // Plain word ` with `. Deliberate contrast with extraction's
    // must-not-strip contract: extractHeadliner keeps `Elvis Costello with
    // Steve Nieve` verbatim (over-stripping could mangle a real name); the
    // gate merely WITHHOLDS it from the LML send, which costs nothing.
    ['Elvis Costello with Steve Nieve', 'with'],
    ['Built to Spill with Prism Bitch', 'with'],
  ])('isCleanHeadliner(%j) === false (%s)', (name) => {
    expect(isCleanHeadliner(name)).toBe(false);
  });
});

describe('isCleanHeadliner — extraction residue gates', () => {
  it.each([
    // Names extraction would still change are by definition not clean —
    // covers legacy rows scraped before BS#1604 deployed.
    '(SOLD OUT) Jessica Pratt',
    'Deerhoof w/ Sword II',
    'Mdou Moctar feat. Mikey Coltun',
    '(LOW TIX) An Evening With: Deerhoof',
    // Pure-tag billings: extractHeadliner's empty-cleanup fallback returns
    // them VERBATIM (better stored than dropped), so the fixpoint test
    // alone would wrongly call them clean. The gate must still reject —
    // these are ticketing residue, not artist names.
    '(SOLD OUT)',
    '(18+)',
    'An Evening With:',
    // Blank input is never clean.
    '',
    '   ',
  ])('isCleanHeadliner(%j) === false', (name) => {
    expect(isCleanHeadliner(name)).toBe(false);
  });
});

describe('isCleanHeadliner — composition with extractHeadliner', () => {
  it.each([
    // Extraction output of a strippable billing is clean...
    ['(SOLD OUT) Jessica Pratt', true],
    ['Wednesday w/Truth Club', true],
    ['(LOW TIX) (18+) An Evening With: Deerhoof w/ Sword II', true],
    // ...but extraction never strips hard delimiters, so a comma/`+`
    // billing stays gated even after extraction.
    ['Wishy, special guest TBA', false],
    ['Sylvan Esso + Flock of Dimes', false],
  ])('isCleanHeadliner(extractHeadliner(%j)) === %j', (billing, expected) => {
    expect(isCleanHeadliner(extractHeadliner(billing))).toBe(expected);
  });
});
