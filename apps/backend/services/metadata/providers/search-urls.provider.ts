/**
 * Search URL provider for services without API integration.
 *
 * Two responsibilities, with different ownership:
 *   1. **Spotify + Apple Music** — read-path-only fallbacks. Always return a
 *      keyword-search URL; iOS uses these on the proxy controller's playcut
 *      detail view (BS#1184/BS#1185). Deliberately NOT in `@wxyc/metadata`
 *      because persisting them on the write path would launder a load-
 *      bearing "couldn't verify" signal into a clickable button — see the
 *      long comment in `metadata.service.ts#fetchMetadata`.
 *   2. **YouTube Music + Bandcamp + SoundCloud** — synthesizable fallbacks
 *      used both at write time (enrichment-worker + jobs) and at read time.
 *      These delegate to `synthesizeSearchUrls` in `@wxyc/metadata` so the
 *      backend + worker + jobs all share one source of truth (BS#889 retired
 *      the parity-test arrangement by collapsing the inline copies into the
 *      shared module).
 *
 * `getAllSearchUrls` returns a camelCase object because that's what the
 * backend's `AlbumMetadataResult` shape uses; the deep module's snake_case
 * is converted at this seam.
 */

import { synthesizeSearchUrls } from '@wxyc/metadata';

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
   * Get YouTube Music search URL. Delegates to `@wxyc/metadata`.
   */
  getYoutubeMusicUrl(artistName: string, trackTitle?: string, albumTitle?: string): string {
    return synthesizeSearchUrls({ artist: artistName, album: albumTitle, track: trackTitle }).youtube_music_url;
  }

  /**
   * Get Bandcamp search URL. Delegates to `@wxyc/metadata`.
   */
  getBandcampUrl(artistName: string, albumTitle?: string): string {
    return synthesizeSearchUrls({ artist: artistName, album: albumTitle }).bandcamp_url;
  }

  /**
   * Get SoundCloud search URL. Delegates to `@wxyc/metadata`.
   */
  getSoundcloudUrl(artistName: string, trackTitle?: string): string {
    return synthesizeSearchUrls({ artist: artistName, track: trackTitle }).soundcloud_url;
  }

  /**
   * Get all search URLs for a given entry. camelCase keys to match
   * `AlbumMetadataResult`.
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
    const synth = synthesizeSearchUrls({ artist: artistName, album: albumTitle, track: trackTitle });
    return {
      spotifyUrl: this.getSpotifyUrl(artistName, trackTitle, albumTitle),
      appleMusicUrl: this.getAppleMusicUrl(artistName, trackTitle, albumTitle),
      youtubeMusicUrl: synth.youtube_music_url,
      bandcampUrl: synth.bandcamp_url,
      soundcloudUrl: synth.soundcloud_url,
    };
  }
}
