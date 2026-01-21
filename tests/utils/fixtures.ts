import { EnrichedLibraryResult } from '@/services/requestLine/types';

// =============================================================================
// Base Test Data
// =============================================================================

export const testArtist = {
  id: 1,
  artist_name: 'Test Artist',
  code_letters: 'RO',
  code_artist_number: 1,
  genre_id: 1,
};

export const testAlbum = {
  id: 1,
  artist_id: 1,
  album_title: 'Test Album',
  code_number: 1,
  genre_id: 1,
  format_id: 1,
};

const baseEnrichedLibraryResult: EnrichedLibraryResult = {
  id: 1,
  title: 'Test Album',
  artist: 'Test Artist',
  codeLetters: 'RO',
  codeArtistNumber: 1,
  codeNumber: 1,
  genre: 'Rock',
  format: 'CD',
  callNumber: 'Rock CD RO 1/1',
  libraryUrl: 'http://www.wxyc.info/wxycdb/libraryRelease?id=1',
};

// =============================================================================
// Factory Functions
// =============================================================================

export function createTestArtist(overrides = {}) {
  return { ...testArtist, ...overrides };
}

export function createTestAlbum(overrides = {}) {
  return { ...testAlbum, ...overrides };
}

/**
 * Creates an EnrichedLibraryResult with sensible defaults.
 * Pass overrides to customize specific fields.
 */
export function createEnrichedLibraryResult(
  overrides: Partial<EnrichedLibraryResult> = {}
): EnrichedLibraryResult {
  const result = { ...baseEnrichedLibraryResult, ...overrides };

  // Auto-generate callNumber and libraryUrl if id changes
  if (overrides.id && !overrides.callNumber) {
    result.callNumber = `${result.genre} ${result.format} ${result.codeLetters} ${result.codeArtistNumber}/${result.codeNumber}`;
  }
  if (overrides.id && !overrides.libraryUrl) {
    result.libraryUrl = `http://www.wxyc.info/wxycdb/libraryRelease?id=${result.id}`;
  }

  return result;
}

/**
 * Creates multiple EnrichedLibraryResults for testing filtering/sorting.
 */
export function createLibraryResultSet(): EnrichedLibraryResult[] {
  return [
    createEnrichedLibraryResult({
      id: 1,
      title: 'Album One',
      artist: 'Test Artist',
      codeNumber: 1,
    }),
    createEnrichedLibraryResult({
      id: 2,
      title: 'Album Two',
      artist: 'Test Artist',
      codeNumber: 2,
    }),
    createEnrichedLibraryResult({
      id: 3,
      title: 'Other Album',
      artist: 'Different Artist',
      codeArtistNumber: 2,
      codeNumber: 1,
    }),
  ];
}
