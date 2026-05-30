import type { DiscogsMatchResult } from '@wxyc/lml-client';

/**
 * Detect LML's streaming-only synthesized result shape (LML#401).
 *
 * On a Discogs miss, LML's `enrich_artwork_results` synthesizes a
 * `DiscogsSearchResult(release_id=0, release_url="")` carrying only
 * streaming URLs — no real album-derived fields. Callers key off this
 * sentinel pair to skip persisting `release_id=0` / `discogs_url=""`
 * on the flowsheet (would otherwise pollute filtered queries like
 * `WHERE discogs_release_id IS NOT NULL` and surface as `release_id=0`
 * on the iOS detail view). Streaming URLs still flow.
 */
export const isSyntheticArtwork = (artwork: DiscogsMatchResult): boolean =>
  artwork.release_id === 0 && artwork.release_url === '';
