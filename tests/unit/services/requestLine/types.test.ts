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
    codeVolumeLetters: null,
    codeCompLetter: null,
    genre: 'Hiphop',
    format: 'cd',
    ...overrides,
  };
}

describe('computeCallNumber', () => {
  it.each<[string, Partial<LibraryResult>, string]>([
    ['single-bin genre renders V/A-<ReleaseNum>, no artist number', {}, 'Hiphop cd V/A-651'],
    [
      'Rock with a recoverable bin letter renders V/A <Bin>-<ReleaseNum>',
      { artist: 'Various Artists - Rock', codeCompLetter: 'M', codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A M-121',
    ],
    [
      'Soundtracks with a recoverable bin letter renders <Bin>-<ReleaseNum>, no V/A literal',
      { artist: 'Soundtracks', codeCompLetter: 'M', codeNumber: 12, genre: 'Soundtracks' },
      'Soundtracks cd M-12',
    ],
    [
      'a rename that dropped the section suffix still renders the bin from codeCompLetter',
      { artist: 'Various Artists - Rock', codeCompLetter: 'M', codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A M-121',
    ],
    [
      'a name suffix with a null codeCompLetter renders no bin: the name is not read',
      { artist: 'Various Artists - Rock - M', codeCompLetter: null, codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A-121',
    ],
    [
      'a lowercase codeCompLetter renders upper-cased',
      { codeCompLetter: 'm', codeNumber: 12, genre: 'Soundtracks' },
      'Soundtracks cd M-12',
    ],
    [
      'Soundtracks without a recoverable bin letter falls back to V/A-<ReleaseNum>',
      { codeNumber: 53, genre: 'Soundtracks' },
      'Soundtracks cd V/A-53',
    ],
    [
      // Proves the legacy bin comes from codeLetters, not from the name.
      'legacy Z-M (lettered) spelling recovers its bin from codeLetters[2], not from the name',
      { artist: 'Raw Tubafrenzy Export', codeLetters: 'Z-M', codeNumber: 121, genre: 'Rock' },
      'Rock cd V/A M-121',
    ],
    [
      'legacy Z-- (single-bin) spelling is treated as a compilation with no bin',
      { codeLetters: 'Z--' },
      'Hiphop cd V/A-651',
    ],
    ['lowercase/padded "v/a " is still recognized structurally', { codeLetters: ' v/a ' }, 'Hiphop cd V/A-651'],
    [
      'null codeNumber on a compilation renders V/A with no release half, no trailing hyphen',
      { codeNumber: null },
      'Hiphop cd V/A',
    ],
    [
      'null codeNumber on a Rock compilation with a bin letter renders V/A <Bin>, no trailing hyphen',
      { artist: 'Various Artists - Rock', codeCompLetter: 'M', codeNumber: null, genre: 'Rock' },
      'Rock cd V/A M',
    ],
    [
      'a trailing " - <letter>" on the name is ignored outside Rock/Soundtracks',
      { artist: 'Various Artists - M', codeCompLetter: 'M' },
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
      'a comp letter is ignored under a non-Rock/Soundtracks genre',
      { artist: 'Various Artists - Rock', codeCompLetter: 'M', codeNumber: 651, genre: 'Hiphop' },
      'Hiphop cd V/A-651',
    ],
    [
      'null genre and format are skipped, leaving the bare compilation locator',
      { artist: 'Various Artists - Rock', codeCompLetter: 'M', codeNumber: 121, genre: null, format: null },
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
    [
      'volume letter is appended to the release number on a named artist',
      {
        ...{ artist: 'Stereolab', codeLetters: 'ST', codeArtistNumber: 12, codeNumber: 3, genre: 'Rock', format: 'CD' },
        codeVolumeLetters: 'B',
      },
      'Rock CD ST 12/3-B',
    ],
    [
      'volume letter is appended to the release number on a Rock compilation',
      {
        artist: 'Various Artists - Rock',
        codeCompLetter: 'A',
        codeNumber: 12,
        genre: 'Rock',
        format: 'cd',
        codeVolumeLetters: 'B',
      },
      'Rock cd V/A A-12-B',
    ],
    ['volume letter is appended on a single-bin compilation', { codeVolumeLetters: 'C' }, 'Hiphop cd V/A-651-C'],
    ['a lowercase volume letter renders upper-cased', { codeVolumeLetters: 'b' }, 'Hiphop cd V/A-651-B'],
    ['a blank or whitespace-only volume letter renders no hyphen', { codeVolumeLetters: '  ' }, 'Hiphop cd V/A-651'],
    ['a padded volume letter is trimmed', { codeVolumeLetters: ' b ' }, 'Hiphop cd V/A-651-B'],
    [
      'a volume letter without a release number is dropped on a compilation',
      { codeNumber: null, codeVolumeLetters: 'B' },
      'Hiphop cd V/A',
    ],
    [
      'letters without an artist number render the release half after the letters (LML parity)',
      { artist: 'Stereolab', codeLetters: 'ST', codeArtistNumber: null, codeNumber: 3, genre: 'Rock', format: 'cd' },
      'Rock cd ST/3',
    ],
    [
      'letters without an artist number keep the volume letter',
      {
        artist: 'Stereolab',
        codeLetters: 'ST',
        codeArtistNumber: null,
        codeNumber: 3,
        genre: 'Rock',
        format: 'cd',
        codeVolumeLetters: 'B',
      },
      'Rock cd ST/3-B',
    ],
    [
      'no letters and no artist number render the bare release number (LML parity)',
      { artist: 'Stereolab', codeLetters: null, codeArtistNumber: null, codeNumber: 3, genre: 'Rock', format: 'cd' },
      'Rock cd 3',
    ],
    [
      'no letters and no artist number keep the volume letter',
      {
        artist: 'Stereolab',
        codeLetters: null,
        codeArtistNumber: null,
        codeNumber: 3,
        genre: 'Rock',
        format: 'cd',
        codeVolumeLetters: 'B',
      },
      'Rock cd 3-B',
    ],
    [
      'a volume letter without a release number is dropped on a named artist',
      {
        artist: 'Stereolab',
        codeLetters: 'ST',
        codeArtistNumber: 12,
        codeNumber: null,
        genre: 'Rock',
        format: 'cd',
        codeVolumeLetters: 'B',
      },
      'Rock cd ST 12',
    ],
  ])('%s', (_description, overrides, expected) => {
    expect(computeCallNumber(makeResult(overrides))).toBe(expected);
  });
});
