/**
 * Barrel export for artwork services.
 */

export { ArtworkFinder, getArtworkFinder, resetArtworkFinder, fetchArtworkForItems } from './finder.js';
export type { ArtworkProvider } from './providers/index.js';
export { DiscogsProvider, discogsProvider } from './providers/index.js';
export { LastFmProvider, lastFmProvider } from './providers/index.js';
export { ITunesProvider, itunesProvider } from './providers/index.js';
export { classify as classifyNSFW, preloadModel as preloadNSFWModel } from './nsfw.js';
