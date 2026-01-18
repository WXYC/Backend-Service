/**
 * Metadata service exports
 */
export * from './metadata.types.js';
export {
  generateAlbumCacheKey,
  generateArtistCacheKey,
  getAlbumMetadata,
  setAlbumMetadata,
  getArtistMetadata,
  setArtistMetadata,
  albumMetadataExists,
  artistMetadataExists,
} from './metadata.cache.js';
export { fetchAndCacheMetadata } from './metadata.service.js';
export { DiscogsProvider } from './providers/discogs.provider.js';
export { SpotifyProvider } from './providers/spotify.provider.js';
export { AppleMusicProvider } from './providers/apple.provider.js';
export { SearchUrlProvider } from './providers/search-urls.provider.js';
