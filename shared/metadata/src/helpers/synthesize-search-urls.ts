import type { MetadataFallbacks } from '../normalize-lookup.js';

/**
 * Synthesized search URLs (per-service semantics deliberately asymmetric):
 *   - YouTube Music: track > album > artist
 *   - Bandcamp:      album > artist (album-leaning)
 *   - SoundCloud:    track > artist (NO album fallback — album-only
 *                    SoundCloud queries surface unrelated DJ mixes)
 *
 * Spotify and Apple Music intentionally have no synthesized fallback here
 * (BS#1184 / BS#1192): persisting a keyword-search URL would launder a
 * load-bearing "we couldn't verify a real match" signal into a clickable
 * button that drops users on the in-app search page. They're filled at
 * read time on the proxy controller, where there's no row to poison.
 */
export const synthesizeSearchUrls = (
  fallbacks: MetadataFallbacks
): { youtube_music_url: string; bandcamp_url: string; soundcloud_url: string } => {
  const artist = fallbacks.artist;
  const album = fallbacks.album ?? undefined;
  const track = fallbacks.track ?? undefined;

  const youtubeQuery = track ? `${artist} ${track}` : album ? `${artist} ${album}` : artist;
  const bandcampQuery = album ? `${artist} ${album}` : artist;
  const soundcloudQuery = track ? `${artist} ${track}` : artist;

  return {
    youtube_music_url: `https://music.youtube.com/search?q=${encodeURIComponent(youtubeQuery)}`,
    bandcamp_url: `https://bandcamp.com/search?q=${encodeURIComponent(bandcampQuery)}`,
    soundcloud_url: `https://soundcloud.com/search?q=${encodeURIComponent(soundcloudQuery)}`,
  };
};
