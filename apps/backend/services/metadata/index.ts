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
export { SearchUrlProvider } from './providers/search-urls.provider.js';
