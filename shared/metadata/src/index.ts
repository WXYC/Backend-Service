export { normalizeLookup } from './normalize-lookup.js';
export type { NormalizedMetadata, MetadataFallbacks } from './normalize-lookup.js';
export { filterSpacerGif } from './helpers/filter-spacer-gif.js';
export { isSyntheticArtwork } from './helpers/is-synthetic-artwork.js';
export { cleanDiscogsBio } from './helpers/clean-discogs-bio.js';
export {
  classifyArtworkProvenance,
  decodeDiscogsImageKey,
  isWrongArtworkProvenance,
} from './helpers/discogs-image-provenance.js';
export type { ArtworkProvenance } from './helpers/discogs-image-provenance.js';
export { synthesizeSearchUrls } from './helpers/synthesize-search-urls.js';
export { CLEAR_RELEASE_GROUP, buildReleaseGroup } from './helpers/release-group.js';
export type { ReleaseGroup } from './helpers/release-group.js';
