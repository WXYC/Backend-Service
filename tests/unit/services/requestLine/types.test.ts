/**
 * BS#2822: `computeCallNumber` must render Various Artists compilation rows
 * in their shelf form instead of the regular-artist pattern, which produces
 * a locator that doesn't exist on the shelf (`V/A 0/<n>`) and, for Rock and
 * Soundtracks, is ambiguous without the bin letter. Output must match
 * LML#1427's `LibraryItem.call_number` character for character.
 */
import { computeCallNumber, type LibraryResult } from '../../../../apps/backend/services/requestLine/types';

function makeResult(overrides: Partial<LibraryResult>): LibraryResult {
  return {
    id: 1,
    title: 'Music for Plants',
    artist: 'Various Artists',
    alphabeticalName: null,
    codeLetters: 'V/A',
    codeArtistNumber: 0,
    codeNumber: 651,
    genre: 'Hiphop',
    format: 'cd',
    ...overrides,
  };
}

describe('computeCallNumber', () => {
  it.each<[string, Partial<LibraryResult>, string]>([
    [
      'single-bin genre renders V/A-<ReleaseNum>, no artist number',
      {
        artist: 'Various Artists',
        codeLetters: 'V/A',
        codeArtistNumber: 0,
        codeNumber: 651,
        genre: 'Hiphop',
        format: 'cd',
      },
      'Hiphop cd V/A-651',
    ],
    [
      'Rock with a recoverable bin letter renders V/A <Bin>-<ReleaseNum>',
      {
        artist: 'Various Artists - Rock - M',
        codeLetters: 'V/A',
        codeArtistNumber: 0,
        codeNumber: 121,
        genre: 'Rock',
        format: 'cd',
      },
      'Rock cd V/A M-121',
    ],
    [
      'Soundtracks with a recoverable bin letter renders <Bin>-<ReleaseNum>, no V/A literal',
      {
        artist: 'Soundtracks - M',
        codeLetters: 'V/A',
        codeArtistNumber: 0,
        codeNumber: 12,
        genre: 'Soundtracks',
        format: 'cd',
      },
      'Soundtracks cd M-12',
    ],
    [
      'Soundtracks without a recoverable bin letter falls back to V/A-<ReleaseNum>',
      {
        artist: 'Various Artists',
        codeLetters: 'V/A',
        codeArtistNumber: 0,
        codeNumber: 53,
        genre: 'Soundtracks',
        format: 'cd',
      },
      'Soundtracks cd V/A-53',
    ],
    [
      'legacy Z-M (lettered) spelling recovers its bin from codeLetters[2], not from the name',
      {
        // Deliberately NOT the renamed "Various Artists - Rock - M" form --
        // this proves the bin comes from codeLetters, matching the LML#1427
        // "In that form, take the bin from call_letters[2]" rule.
        artist: 'Raw Tubafrenzy Export',
        codeLetters: 'Z-M',
        codeArtistNumber: 0,
        codeNumber: 121,
        genre: 'Rock',
        format: 'cd',
      },
      'Rock cd V/A M-121',
    ],
    [
      'legacy Z-- (single-bin) spelling is treated as a compilation with no bin',
      {
        artist: 'Various Artists',
        codeLetters: 'Z--',
        codeArtistNumber: 0,
        codeNumber: 651,
        genre: 'Hiphop',
        format: 'cd',
      },
      'Hiphop cd V/A-651',
    ],
    [
      'lowercase/padded "v/a " is still recognized structurally',
      {
        artist: 'Various Artists',
        codeLetters: ' v/a ',
        codeArtistNumber: 0,
        codeNumber: 651,
        genre: 'Hiphop',
        format: 'cd',
      },
      'Hiphop cd V/A-651',
    ],
    [
      'null codeNumber on a compilation renders V/A with no release half, no trailing hyphen',
      {
        artist: 'Various Artists',
        codeLetters: 'V/A',
        codeArtistNumber: 0,
        codeNumber: null,
        genre: 'Hiphop',
        format: 'cd',
      },
      'Hiphop cd V/A',
    ],
    [
      'null codeNumber on a Rock compilation with a bin letter renders V/A <Bin>, no trailing hyphen',
      {
        artist: 'Various Artists - Rock - M',
        codeLetters: 'V/A',
        codeArtistNumber: 0,
        codeNumber: null,
        genre: 'Rock',
        format: 'cd',
      },
      'Rock cd V/A M',
    ],
    [
      'a trailing " - <letter>" on the name is ignored outside Rock/Soundtracks',
      {
        artist: 'Various Artists - M',
        codeLetters: 'V/A',
        codeArtistNumber: 0,
        codeNumber: 651,
        genre: 'Hiphop',
        format: 'cd',
      },
      'Hiphop cd V/A-651',
    ],
    [
      'legacy Z-<letter> on Soundtracks renders the bare bin from codeLetters',
      { artist: 'Raw Tubafrenzy Export', codeLetters: 'Z-K', codeNumber: 12, genre: 'Soundtracks' },
      'Soundtracks cd K-12',
    ],
    [
      'legacy Z-- on Rock has no bin and does not fall through to the name',
      { artist: 'Various Artists - Rock - M', codeLetters: 'Z--', codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A-121',
    ],
    [
      'legacy Z-M on a single-bin genre drops the bin (Java renders it only for Rock/Soundtracks)',
      { codeLetters: 'Z-M', codeNumber: 651, genre: 'Hiphop' },
      'Hiphop cd V/A-651',
    ],
    [
      'legacy Z- code takes any non-hyphen character at index 2, as substring(2, 3) does',
      { codeLetters: 'Z-1', codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A 1-121',
    ],
    [
      'a Rock bin heading in the name is ignored under a non-Rock genre',
      { artist: 'Various Artists - Rock - M', codeNumber: 651, genre: 'Hiphop' },
      'Hiphop cd V/A-651',
    ],
    [
      'a multi-letter name suffix is not a bin letter',
      { artist: 'Various Artists - Rock - Africa', codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A-121',
    ],
    [
      'the name is trimmed at both ends before the bin suffix is read',
      { artist: ' - M', codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A-121',
    ],
    [
      'null genre and format are skipped, leaving the bare compilation locator',
      { artist: 'Various Artists - Rock - M', codeNumber: 121, genre: null, format: null },
      'V/A-121',
    ],
    [
      'unchanged named-artist row is untouched by the compilation branch',
      {
        artist: 'Stereolab',
        codeLetters: 'ST',
        codeArtistNumber: 12,
        codeNumber: 3,
        genre: 'Rock',
        format: 'CD',
      },
      'Rock CD ST 12/3',
    ],
  ])('%s', (_description, overrides, expected) => {
    expect(computeCallNumber(makeResult(overrides))).toBe(expected);
  });
});
