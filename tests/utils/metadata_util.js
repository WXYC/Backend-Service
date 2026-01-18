/**
 * Metadata test utilities
 *
 * Helper functions for testing metadata service integration
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * Wait for metadata to be populated for a flowsheet entry
 *
 * Since metadata is fetched fire-and-forget, we need to poll
 * until the metadata appears or timeout is reached.
 *
 * @param {number} entryId - The flowsheet entry ID to check
 * @param {number} maxWaitMs - Maximum time to wait (default 5000ms)
 * @param {number} pollIntervalMs - Polling interval (default 500ms)
 * @returns {Promise<Object|null>} The entry with metadata, or null if not found
 */
exports.waitForMetadata = async (entryId, maxWaitMs = 5000, pollIntervalMs = 500) => {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const res = await request.get('/flowsheet').query({ limit: 100 }).send();

    if (res.status === 200) {
      const entry = res.body.find((e) => e.id === entryId);

      // Check if any metadata field is populated
      if (
        entry &&
        (entry.artwork_url ||
          entry.spotify_url ||
          entry.apple_music_url ||
          entry.youtube_music_url ||
          entry.discogs_url)
      ) {
        return entry;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Return the latest state even if no metadata found
  const finalRes = await request.get('/flowsheet').query({ limit: 100 }).send();
  if (finalRes.status === 200) {
    return finalRes.body.find((e) => e.id === entryId) || null;
  }
  return null;
};

/**
 * Check if an entry has any album metadata
 *
 * @param {Object} entry - Flowsheet entry object
 * @returns {boolean} True if entry has any album metadata
 */
exports.hasAlbumMetadata = (entry) => {
  return !!(
    entry.artwork_url ||
    entry.spotify_url ||
    entry.apple_music_url ||
    entry.discogs_url ||
    entry.youtube_music_url ||
    entry.bandcamp_url ||
    entry.soundcloud_url ||
    entry.release_year
  );
};

/**
 * Check if an entry has any artist metadata
 *
 * @param {Object} entry - Flowsheet entry object
 * @returns {boolean} True if entry has any artist metadata
 */
exports.hasArtistMetadata = (entry) => {
  return !!(entry.artist_bio || entry.artist_wikipedia_url);
};

/**
 * Get all metadata fields from an entry
 *
 * @param {Object} entry - Flowsheet entry object
 * @returns {Object} Object containing only metadata fields
 */
exports.extractMetadataFields = (entry) => {
  return {
    // Album metadata
    artwork_url: entry.artwork_url,
    discogs_url: entry.discogs_url,
    release_year: entry.release_year,
    spotify_url: entry.spotify_url,
    apple_music_url: entry.apple_music_url,
    youtube_music_url: entry.youtube_music_url,
    bandcamp_url: entry.bandcamp_url,
    soundcloud_url: entry.soundcloud_url,
    // Artist metadata
    artist_bio: entry.artist_bio,
    artist_wikipedia_url: entry.artist_wikipedia_url,
  };
};

/**
 * List of all metadata field names expected in flowsheet responses
 */
exports.METADATA_FIELDS = [
  'artwork_url',
  'discogs_url',
  'release_year',
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
  'bandcamp_url',
  'soundcloud_url',
  'artist_bio',
  'artist_wikipedia_url',
];
