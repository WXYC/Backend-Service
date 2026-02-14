/**
 * Barrel export for Discogs service.
 */

export { DiscogsService, isDiscogsAvailable } from './discogs.service.js';
export { discogsClient, parseTitle, resetDiscogsClient } from './client.js';
export { getTrackCache, getReleaseCache, getSearchCache, clearAllCaches, resetAllCaches } from './cache.js';
export * from './types.js';
