/**
 * Unit tests for metadata cache key generation functions
 */

// Pure functions extracted for testing
const generateAlbumCacheKey = (artistName: string, albumTitle?: string): string => {
  const normalized = `${artistName.toLowerCase().trim()}-${(albumTitle || '').toLowerCase().trim()}`;
  return normalized.substring(0, 512);
};

const generateArtistCacheKey = (artistName: string): string => {
  return artistName.toLowerCase().trim().substring(0, 256);
};

describe('generateAlbumCacheKey', () => {
  describe('basic functionality', () => {
    it('should generate key from artist and album', () => {
      const key = generateAlbumCacheKey('The Beatles', 'Abbey Road');
      expect(key).toBe('the beatles-abbey road');
    });

    it('should generate key with only artist name', () => {
      const key = generateAlbumCacheKey('Miles Davis');
      expect(key).toBe('miles davis-');
    });

    it('should generate key with undefined album title', () => {
      const key = generateAlbumCacheKey('Miles Davis', undefined);
      expect(key).toBe('miles davis-');
    });

    it('should generate key with empty album title', () => {
      const key = generateAlbumCacheKey('Miles Davis', '');
      expect(key).toBe('miles davis-');
    });
  });

  describe('normalization', () => {
    it('should lowercase artist name', () => {
      const key = generateAlbumCacheKey('THE BEATLES', 'Abbey Road');
      expect(key).toBe('the beatles-abbey road');
    });

    it('should lowercase album title', () => {
      const key = generateAlbumCacheKey('The Beatles', 'ABBEY ROAD');
      expect(key).toBe('the beatles-abbey road');
    });

    it('should trim whitespace from artist name', () => {
      const key = generateAlbumCacheKey('  The Beatles  ', 'Abbey Road');
      expect(key).toBe('the beatles-abbey road');
    });

    it('should trim whitespace from album title', () => {
      const key = generateAlbumCacheKey('The Beatles', '  Abbey Road  ');
      expect(key).toBe('the beatles-abbey road');
    });

    it('should handle mixed case and whitespace', () => {
      const key = generateAlbumCacheKey('  THE BEATLES  ', '  ABBEY ROAD  ');
      expect(key).toBe('the beatles-abbey road');
    });
  });

  describe('special characters', () => {
    it('should preserve special characters', () => {
      const key = generateAlbumCacheKey("Guns N' Roses", "Appetite for Destruction");
      expect(key).toBe("guns n' roses-appetite for destruction");
    });

    it('should handle unicode characters', () => {
      const key = generateAlbumCacheKey('Björk', 'Homogenic');
      expect(key).toBe('björk-homogenic');
    });

    it('should handle numbers', () => {
      const key = generateAlbumCacheKey('U2', 'The Joshua Tree');
      expect(key).toBe('u2-the joshua tree');
    });
  });

  describe('length limits', () => {
    it('should truncate keys longer than 512 characters', () => {
      const longArtist = 'A'.repeat(300);
      const longAlbum = 'B'.repeat(300);
      const key = generateAlbumCacheKey(longArtist, longAlbum);

      expect(key.length).toBe(512);
    });

    it('should not truncate keys under 512 characters', () => {
      const key = generateAlbumCacheKey('Short Artist', 'Short Album');
      expect(key.length).toBeLessThan(512);
      expect(key).toBe('short artist-short album');
    });
  });
});

describe('generateArtistCacheKey', () => {
  describe('basic functionality', () => {
    it('should generate key from artist name', () => {
      const key = generateArtistCacheKey('The Beatles');
      expect(key).toBe('the beatles');
    });
  });

  describe('normalization', () => {
    it('should lowercase artist name', () => {
      const key = generateArtistCacheKey('THE BEATLES');
      expect(key).toBe('the beatles');
    });

    it('should trim whitespace', () => {
      const key = generateArtistCacheKey('  The Beatles  ');
      expect(key).toBe('the beatles');
    });
  });

  describe('length limits', () => {
    it('should truncate keys longer than 256 characters', () => {
      const longArtist = 'A'.repeat(300);
      const key = generateArtistCacheKey(longArtist);

      expect(key.length).toBe(256);
    });
  });
});
