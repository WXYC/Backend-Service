import {
  generateAlbumCacheKey,
  generateArtistCacheKey,
} from '@/services/metadata/metadata.cache';

describe('metadata.cache', () => {
  describe('generateAlbumCacheKey', () => {
    it('generates normalized key from artist and album', () => {
      const key = generateAlbumCacheKey('Test Artist', 'Test Album');
      expect(key).toBe('test artist-test album');
    });

    it('handles missing album title', () => {
      const key = generateAlbumCacheKey('Test Artist');
      expect(key).toBe('test artist-');
    });

    it('handles empty album title', () => {
      const key = generateAlbumCacheKey('Test Artist', '');
      expect(key).toBe('test artist-');
    });

    it('normalizes to lowercase', () => {
      const key = generateAlbumCacheKey('TEST ARTIST', 'TEST ALBUM');
      expect(key).toBe('test artist-test album');
    });

    it('trims whitespace', () => {
      const key = generateAlbumCacheKey('  Test Artist  ', '  Test Album  ');
      expect(key).toBe('test artist-test album');
    });

    it('truncates to 512 characters', () => {
      const longArtist = 'a'.repeat(300);
      const longAlbum = 'b'.repeat(300);
      const key = generateAlbumCacheKey(longArtist, longAlbum);
      expect(key.length).toBe(512);
    });

    it('preserves special characters', () => {
      const key = generateAlbumCacheKey('Artist & Co.', "Album's Title!");
      expect(key).toBe("artist & co.-album's title!");
    });

    it('handles unicode characters', () => {
      const key = generateAlbumCacheKey('Björk', 'Début');
      expect(key).toBe('björk-début');
    });
  });

  describe('generateArtistCacheKey', () => {
    it('generates normalized key from artist name', () => {
      const key = generateArtistCacheKey('Test Artist');
      expect(key).toBe('test artist');
    });

    it('normalizes to lowercase', () => {
      const key = generateArtistCacheKey('TEST ARTIST');
      expect(key).toBe('test artist');
    });

    it('trims whitespace', () => {
      const key = generateArtistCacheKey('  Test Artist  ');
      expect(key).toBe('test artist');
    });

    it('truncates to 256 characters', () => {
      const longArtist = 'a'.repeat(300);
      const key = generateArtistCacheKey(longArtist);
      expect(key.length).toBe(256);
    });

    it('preserves special characters', () => {
      const key = generateArtistCacheKey('Artist & Co.');
      expect(key).toBe('artist & co.');
    });

    it('handles unicode characters', () => {
      const key = generateArtistCacheKey('Sigur Rós');
      expect(key).toBe('sigur rós');
    });

    it('handles empty string', () => {
      const key = generateArtistCacheKey('');
      expect(key).toBe('');
    });
  });
});
