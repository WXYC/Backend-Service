/**
 * Unit tests for credit-split.ts — turns an artist's comma-joined
 * `library.alternate_artist_name` credits into the single names written under
 * the relational `wxyc_library_credit` source (BS#3554).
 *
 * The rules are the conservative set from the BS#3554 survey of the
 * 2026-09-14 library.db snapshot plus the PR #3560 review. Split on commas
 * only, never on `&` / ` and ` / `/`. Leave bracketed lineups whole, and
 * leave comma band names (`Earth, Wind & Fire`) whole. Rejoin name suffixes
 * (`Jr.`, `Inc.`, `The`). Need two distinct names after dropping `et al` /
 * `etc`. Never emit a one-word name, the owner's own name, or a name the
 * artist already has as a `wxyc_library_alt` value.
 */
import { splitLibraryCredits } from '../../../../jobs/artist-search-alias-consumer/credit-split';

describe('splitLibraryCredits', () => {
  it.each<[string, string, string[], string[]]>([
    // [case, owner artist_name, alternate_artist_name values, expected names]
    [
      'the CA 49 value splits into both names',
      'Carolina Chocolate Drops',
      ['Rhiannon Giddens, Our Native Daughters'],
      ['Rhiannon Giddens', 'Our Native Daughters'],
    ],
    [
      'a three-name credit strips the leading "and " from the last piece',
      'Mike Bloomfield',
      ['Mike Bloomfield, Al Kooper, and Steve Stills'],
      ['Al Kooper', 'Steve Stills'],
    ],
    [
      'a leading "& " on the last piece is stripped like "and "',
      'Mike Bloomfield',
      ['Mike Bloomfield, Al Kooper, & Steve Stills'],
      ['Al Kooper', 'Steve Stills'],
    ],
    ['an "&" credit has no comma and is not split', 'Duke Ellington', ['Duke Ellington & John Coltrane'], []],
    ['a comma band name with "&" is not split', 'Keith Emerson', ['Emerson, Lake & Palmer'], []],
    ['a comma band name with "&" is not split (Earth, Wind & Fire)', 'Maurice White', ['Earth, Wind & Fire'], []],
    ['a comma band name with " and " is not split', 'David Crosby', ['Crosby, Stills and Nash'], []],
    ['a comma trio with "&" is not split', 'Jeff Beck', ['Beck, Bogert & Appice'], []],
    [
      'the owner (after normalization, ignoring a leading "The") still counts toward two names but is not emitted',
      'Carolina Chocolate Drops',
      ['Rhiannon Giddens, The Carolina Chocolate Drops'],
      ['Rhiannon Giddens'],
    ],
    ['a single-name value yields nothing', 'Carolina Chocolate Drops', ['Rhiannon Giddens'], []],
    [
      'a name the artist already has as a wxyc_library_alt value is not repeated',
      'Carolina Chocolate Drops',
      ['Rhiannon Giddens, Our Native Daughters', 'rhiannon giddens'],
      ['Our Native Daughters'],
    ],
    [
      'a name credited in two values is written once',
      'Grouper',
      ['Liz Harris, Mirrorring', 'Liz Harris, Raum'],
      ['Liz Harris'],
    ],
    ['a "Jr." suffix rejoins its name, leaving one name', 'Josh White', ['Josh White, Jr.'], []],
    [
      'a suffix rejoins mid-list',
      'Martin Luther King',
      ['Dr. Martin Luther King, Jr., Mahalia Jackson'],
      ['Dr. Martin Luther King, Jr.', 'Mahalia Jackson'],
    ],
    ['an inverted article rejoins', 'Spizz', ['Spizzles, The'], []],
    ['an "Inc." suffix rejoins', 'Scraping Foetus Off the Wheel', ['Foetus, Inc.'], []],
    [
      'IV / Esq / Co / LLC / Bros suffixes rejoin',
      'Hank Williams',
      ['Hank Williams, IV, Ira Louvin, Esq., Louvin, Bros., Starday, Co, Rounder, LLC'],
      ['Hank Williams, IV', 'Ira Louvin, Esq.', 'Louvin, Bros.', 'Starday, Co', 'Rounder, LLC'],
    ],
    ['an inverted "Last, First" personal name yields nothing', 'Chris Cutler', ['Frith, Fred'], []],
    ['"et al" is dropped before counting names', 'Chris Cutler', ['Frith, Fred, et al'], []],
    ['one-word names are never emitted', 'Borbetomagus', ['Sauter, Dietrich, Miller, et al'], []],
    [
      'one-word names are dropped from a list that keeps its multi-word names',
      'Monade',
      ['Laetitia Sadier, Stereolab, Tim Gane'],
      ['Laetitia Sadier', 'Tim Gane'],
    ],
    [
      'a bracketed lineup is not split',
      'Johnny Dyani',
      ['Johnny Dyani Quartet [with Don Cherry, Dudu Pukwana, Makaya Ntshoko]'],
      [],
    ],
    ['a parenthesised lineup is not split', 'Mos Def', ['Urban Renewal Program (Mos Def, Diverse, Prefuse 73)'], []],
    [
      'blank pieces and same-value duplicates are dropped',
      'Stereolab',
      ['Laetitia Sadier, , Tim Gane,Laetitia Sadier '],
      ['Laetitia Sadier', 'Tim Gane'],
    ],
    ['a value repeating one name is not a multi-name credit', 'Stereolab', ['Tim Gane, tim gane'], []],
  ])('%s', (_case, owner, alts, expected) => {
    expect(splitLibraryCredits(alts, owner)).toEqual(expected);
  });
});
