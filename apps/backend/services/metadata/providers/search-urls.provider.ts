/**
 * Search URL provider for services without API integration
 * Constructs search URLs directly (no API calls needed)
 */

export class SearchUrlProvider {
  /**
   * Get YouTube Music search URL
   */
  getYoutubeMusicUrl(artistName: string, trackTitle?: string, albumTitle?: string): string {
    const query = trackTitle ? `${artistName} ${trackTitle}` : albumTitle ? `${artistName} ${albumTitle}` : artistName;
    return `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
  }

  /**
   * Get Bandcamp search URL
   */
  getBandcampUrl(artistName: string, albumTitle?: string): string {
    const query = albumTitle ? `${artistName} ${albumTitle}` : artistName;
    return `https://bandcamp.com/search?q=${encodeURIComponent(query)}`;
  }

  /**
   * Get SoundCloud search URL
   */
  getSoundcloudUrl(artistName: string, trackTitle?: string): string {
    const query = trackTitle ? `${artistName} ${trackTitle}` : artistName;
    return `https://soundcloud.com/search?q=${encodeURIComponent(query)}`;
  }

  /**
   * Get all search URLs for a given entry
   */
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
