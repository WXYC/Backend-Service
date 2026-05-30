/**
 * Drop Discogs `spacer.gif` placeholder URLs.
 *
 * Discogs returns `spacer.gif` when a release has no real cover artwork.
 * Persisting that to `flowsheet.artwork_url` (or `library.artwork_url`,
 * or `album_metadata.artwork_url`) would trip the "has artwork" partial
 * indexes on those tables and result in a broken/blank image on iOS.
 *
 * Returns `null` for both missing input and spacer hits so callers'
 * truthy-checks (`if (url) ...`) work uniformly. See #649, BS#890.
 */
export const filterSpacerGif = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.includes('spacer.gif')) return null;
  return url;
};
