/**
 * Unit tests for credit-split.ts — the comma splitter that turns one
 * comma-joined `library.alternate_artist_name` credit into the single names
 * written under the relational `wxyc_library_credit` source (BS#3554).
 *
 * The rules are the conservative set from the BS#3554 survey of the
 * 2026-09-14 library.db snapshot: split on commas only, never on `&` /
 * ` and ` / `/`; leave bracketed lineups whole; rejoin name suffixes
 * (`Jr.`, `Inc.`, `The`); skip an inverted two-word personal name; drop the
 * owner's own name, `et al` / `etc`, blanks and duplicates.
 */
import { splitLibraryCredit } from '../../../../jobs/artist-search-alias-consumer/credit-split';

describe('splitLibraryCredit', () => {
  it.each<[string, string, string, string[]]>([
    // [case, owner artist_name, alternate_artist_name, expected pieces]
    [
      'the CA 49 value splits into both names',
      'Carolina Chocolate Drops',
      'Rhiannon Giddens, Our Native Daughters',
      ['Rhiannon Giddens', 'Our Native Daughters'],
    ],
    [
      'a three-name credit strips the leading "and " from the last piece',
      'Mike Bloomfield',
      'Mike Bloomfield, Al Kooper, and Steve Stills',
      ['Al Kooper', 'Steve Stills'],
    ],
    ['an "&" credit has no comma and is not split', 'Duke Ellington', 'Duke Ellington & John Coltrane', []],
    [
      'an "&" inside one comma piece stays in that piece',
      'Alchemist',
      'Mike, Wiki & the Alchemist',
      ['Mike', 'Wiki & the Alchemist'],
    ],
    [
      'a piece equal to the owner (after normalization) is dropped',
      'Grouper',
      'Nivhek, Liz Harris, grouper',
      ['Nivhek', 'Liz Harris'],
    ],
    [
      'the owner match ignores a leading "The"',
      'The Red Krayola',
      'Mayo Thompson, Red Krayola, Tom Watson',
      ['Mayo Thompson', 'Tom Watson'],
    ],
    ['a single-name value yields nothing', 'Carolina Chocolate Drops', 'Rhiannon Giddens', []],
    ['a "Jr." suffix rejoins its name, leaving one piece', 'Josh White', 'Josh White, Jr.', []],
    [
      'a suffix rejoins mid-list',
      'Martin Luther King',
      'Dr. Martin Luther King, Jr., Mahalia Jackson',
      ['Dr. Martin Luther King, Jr.', 'Mahalia Jackson'],
    ],
    ['an inverted article rejoins', 'Spizz', 'Spizzles, The', []],
    ['an "Inc." suffix rejoins', 'Scraping Foetus Off the Wheel', 'Foetus, Inc.', []],
    ['an inverted "Last, First" personal name is not split', 'Chris Cutler', 'Frith, Fred', []],
    [
      'a bracketed lineup is not split',
      'Johnny Dyani',
      'Johnny Dyani Quartet [with Don Cherry, Dudu Pukwana, Makaya Ntshoko]',
      [],
    ],
    ['a parenthesised lineup is not split', 'Mos Def', 'Urban Renewal Program (Mos Def, Diverse, Prefuse 73)', []],
    ['"et al" is dropped', 'Borbetomagus', 'Sauter, Dietrich, Miller, et al', ['Sauter', 'Dietrich', 'Miller']],
    [
      'blank pieces and duplicates are dropped',
      'Stereolab',
      'Laetitia Sadier, , Tim Gane,Laetitia Sadier ',
      ['Laetitia Sadier', 'Tim Gane'],
    ],
    [
      'three single-word pieces still split (only a pair reads as an inverted name)',
      'Jeff Beck',
      'Beck, Bogert, and Appice',
      ['Beck', 'Bogert', 'Appice'],
    ],
  ])('%s', (_case, owner, value, expected) => {
    expect(splitLibraryCredit(value, owner)).toEqual(expected);
  });
});
