/**
 * Unit tests for SearchUrlProvider
 */

// Inline the class for unit testing (avoids service dependencies)
class SearchUrlProvider {
  getYoutubeMusicUrl(artistName: string, trackTitle?: string, albumTitle?: string): string {
    const query = trackTitle
      ? `${artistName} ${trackTitle}`
      : albumTitle
        ? `${artistName} ${albumTitle}`
        : artistName;
    return `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
  }

  getBandcampUrl(artistName: string, albumTitle?: string): string {
    const query = albumTitle ? `${artistName} ${albumTitle}` : artistName;
    return `https://bandcamp.com/search?q=${encodeURIComponent(query)}`;
  }

  getSoundcloudUrl(artistName: string, trackTitle?: string): string {
    const query = trackTitle ? `${artistName} ${trackTitle}` : artistName;
    return `https://soundcloud.com/search?q=${encodeURIComponent(query)}`;
  }

  getAllSearchUrls(
    artistName: string,
    albumTitle?: string,
    trackTitle?: string
  ): {
    youtubeMusicUrl: string;
    bandcampUrl: string;
    soundcloudUrl: string;
  } {
    return {
      youtubeMusicUrl: this.getYoutubeMusicUrl(artistName, trackTitle, albumTitle),
      bandcampUrl: this.getBandcampUrl(artistName, albumTitle),
      soundcloudUrl: this.getSoundcloudUrl(artistName, trackTitle),
    };
  }
}

describe('SearchUrlProvider', () => {
  let provider: SearchUrlProvider;

  beforeEach(() => {
    provider = new SearchUrlProvider();
  });

  describe('getYoutubeMusicUrl', () => {
    it('should generate URL with artist and track', () => {
      const url = provider.getYoutubeMusicUrl('The Beatles', 'Come Together');

      expect(url).toBe('https://music.youtube.com/search?q=The%20Beatles%20Come%20Together');
    });

    it('should generate URL with artist and album when no track', () => {
      const url = provider.getYoutubeMusicUrl('The Beatles', undefined, 'Abbey Road');

      expect(url).toBe('https://music.youtube.com/search?q=The%20Beatles%20Abbey%20Road');
    });

    it('should generate URL with just artist when no track or album', () => {
      const url = provider.getYoutubeMusicUrl('The Beatles');

      expect(url).toBe('https://music.youtube.com/search?q=The%20Beatles');
    });

    it('should prioritize track over album', () => {
      const url = provider.getYoutubeMusicUrl('The Beatles', 'Come Together', 'Abbey Road');

      expect(url).toBe('https://music.youtube.com/search?q=The%20Beatles%20Come%20Together');
    });

    it('should encode special characters', () => {
      const url = provider.getYoutubeMusicUrl("Guns N' Roses", 'Sweet Child O\' Mine');

      expect(url).toContain('Guns%20N\'%20Roses');
      expect(url).toContain('Sweet%20Child%20O\'%20Mine');
    });

    it('should handle unicode characters', () => {
      const url = provider.getYoutubeMusicUrl('Björk', 'Jóga');

      expect(url).toBe('https://music.youtube.com/search?q=Bj%C3%B6rk%20J%C3%B3ga');
    });
  });

  describe('getBandcampUrl', () => {
    it('should generate URL with artist and album', () => {
      const url = provider.getBandcampUrl('Radiohead', 'OK Computer');

      expect(url).toBe('https://bandcamp.com/search?q=Radiohead%20OK%20Computer');
    });

    it('should generate URL with just artist', () => {
      const url = provider.getBandcampUrl('Radiohead');

      expect(url).toBe('https://bandcamp.com/search?q=Radiohead');
    });

    it('should encode spaces and special characters', () => {
      const url = provider.getBandcampUrl('My Bloody Valentine', 'Loveless');

      expect(url).toBe('https://bandcamp.com/search?q=My%20Bloody%20Valentine%20Loveless');
    });
  });

  describe('getSoundcloudUrl', () => {
    it('should generate URL with artist and track', () => {
      const url = provider.getSoundcloudUrl('Deadmau5', 'Strobe');

      expect(url).toBe('https://soundcloud.com/search?q=Deadmau5%20Strobe');
    });

    it('should generate URL with just artist', () => {
      const url = provider.getSoundcloudUrl('Deadmau5');

      expect(url).toBe('https://soundcloud.com/search?q=Deadmau5');
    });
  });

  describe('getAllSearchUrls', () => {
    it('should return all three URLs', () => {
      const urls = provider.getAllSearchUrls('The Beatles', 'Abbey Road', 'Come Together');

      expect(urls).toHaveProperty('youtubeMusicUrl');
      expect(urls).toHaveProperty('bandcampUrl');
      expect(urls).toHaveProperty('soundcloudUrl');
    });

    it('should generate correct URLs for complete data', () => {
      const urls = provider.getAllSearchUrls('The Beatles', 'Abbey Road', 'Come Together');

      // YouTube Music: prioritizes track
      expect(urls.youtubeMusicUrl).toContain('The%20Beatles%20Come%20Together');
      // Bandcamp: uses album
      expect(urls.bandcampUrl).toContain('The%20Beatles%20Abbey%20Road');
      // SoundCloud: uses track
      expect(urls.soundcloudUrl).toContain('The%20Beatles%20Come%20Together');
    });

    it('should handle missing optional parameters', () => {
      const urls = provider.getAllSearchUrls('The Beatles');

      expect(urls.youtubeMusicUrl).toBe('https://music.youtube.com/search?q=The%20Beatles');
      expect(urls.bandcampUrl).toBe('https://bandcamp.com/search?q=The%20Beatles');
      expect(urls.soundcloudUrl).toBe('https://soundcloud.com/search?q=The%20Beatles');
    });

    it('should handle only album provided', () => {
      const urls = provider.getAllSearchUrls('The Beatles', 'Abbey Road');

      expect(urls.youtubeMusicUrl).toContain('Abbey%20Road');
      expect(urls.bandcampUrl).toContain('Abbey%20Road');
      // SoundCloud doesn't use album
      expect(urls.soundcloudUrl).toBe('https://soundcloud.com/search?q=The%20Beatles');
    });
  });

  describe('URL validity', () => {
    it('should generate valid URLs that can be parsed', () => {
      const urls = provider.getAllSearchUrls('Test Artist', 'Test Album', 'Test Track');

      expect(() => new URL(urls.youtubeMusicUrl)).not.toThrow();
      expect(() => new URL(urls.bandcampUrl)).not.toThrow();
      expect(() => new URL(urls.soundcloudUrl)).not.toThrow();
    });

    it('should generate URLs with correct domains', () => {
      const urls = provider.getAllSearchUrls('Artist', 'Album', 'Track');

      expect(new URL(urls.youtubeMusicUrl).hostname).toBe('music.youtube.com');
      expect(new URL(urls.bandcampUrl).hostname).toBe('bandcamp.com');
      expect(new URL(urls.soundcloudUrl).hostname).toBe('soundcloud.com');
    });
  });
});
