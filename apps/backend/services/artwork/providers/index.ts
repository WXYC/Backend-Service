/**
 * Barrel export for artwork providers.
 */

export type { ArtworkProvider } from './base.js';
export { DiscogsProvider, discogsProvider } from './discogs.js';
export { LastFmProvider, lastFmProvider, isLastFmAvailable } from './lastfm.js';
export { ITunesProvider, itunesProvider } from './itunes.js';
