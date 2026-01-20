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

// Factory functions for dynamic test data
export function createTestArtist(overrides = {}) {
  return { ...testArtist, ...overrides };
}

export function createTestAlbum(overrides = {}) {
  return { ...testAlbum, ...overrides };
}
