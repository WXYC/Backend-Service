/**
 * Search URL provider for services without API integration
 * Constructs search URLs directly (no API calls needed)
 */

export class SearchUrlProvider {
  /**
   * Get Spotify search URL.
   *
   * Path-style format (`https://open.spotify.com/search/<query>`) matches
   * LML's `_build_streaming_search_url("https://open.spotify.com/search/", …)`
   * so BS-side fallback URLs are byte-identical to LML-surfaced URLs
   * (BS#1185 + LML#401).
   */
  getSpotifyUrl(artistName: string, trackTitle?: string, albumTitle?: string): string {
    const query = trackTitle ? `${artistName} ${trackTitle}` : albumTitle ? `${artistName} ${albumTitle}` : artistName;
    return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
  }

  /**
   * Get Apple Music search URL.
   *
   * `music.apple.com/search?term=<q>` geo-redirects to the caller's local
   * store. Used when LML couldn't surface a verified iTunes match — gives
   * iOS a clickable Apple button instead of greying it out (BS#1184).
   */
  getAppleMusicUrl(artistName: string, trackTitle?: string, albumTitle?: string): string {
    const query = trackTitle ? `${artistName} ${trackTitle}` : albumTitle ? `${artistName} ${albumTitle}` : artistName;
    return `https://music.apple.com/search?term=${encodeURIComponent(query)}`;
  }

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
    spotifyUrl: string;
    appleMusicUrl: string;
    youtubeMusicUrl: string;
    bandcampUrl: string;
    soundcloudUrl: string;
  } {
    return {
      spotifyUrl: this.getSpotifyUrl(artistName, trackTitle, albumTitle),
      appleMusicUrl: this.getAppleMusicUrl(artistName, trackTitle, albumTitle),
      youtubeMusicUrl: this.getYoutubeMusicUrl(artistName, trackTitle, albumTitle),
      bandcampUrl: this.getBandcampUrl(artistName, albumTitle),
      soundcloudUrl: this.getSoundcloudUrl(artistName, trackTitle),
    };
  }
}
