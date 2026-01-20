/**
 * Configuration for Request Line NLP + Library Search feature.
 *
 * All configuration is loaded from environment variables with sensible defaults.
 */

export interface RequestLineConfig {
  // AI Parsing (Required - requests fail without this)
  groqApiKey: string | undefined;
  groqModel: string;

  // Discogs (Optional - artwork/compilation search degrades gracefully)
  discogsApiKey: string | undefined;
  discogsApiSecret: string | undefined;
  discogsCacheTtlTrack: number;
  discogsCacheTtlRelease: number;
  discogsCacheTtlSearch: number;
  discogsCacheMaxSize: number;

  // Feature Flags
  enableArtworkLookup: boolean;
  enableLibrarySearch: boolean;

  // Search behavior
  maxSearchResults: number;
  artistSimilarityThreshold: number;
}

/**
 * Load configuration from environment variables.
 */
export function loadConfig(): RequestLineConfig {
  return {
    // AI Parsing
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',

    // Discogs
    discogsApiKey: process.env.DISCOGS_API_KEY,
    discogsApiSecret: process.env.DISCOGS_API_SECRET,
    discogsCacheTtlTrack: parseInt(process.env.DISCOGS_CACHE_TTL_TRACK || '3600', 10), // 1 hour
    discogsCacheTtlRelease: parseInt(process.env.DISCOGS_CACHE_TTL_RELEASE || '14400', 10), // 4 hours
    discogsCacheTtlSearch: parseInt(process.env.DISCOGS_CACHE_TTL_SEARCH || '3600', 10), // 1 hour
    discogsCacheMaxSize: parseInt(process.env.DISCOGS_CACHE_MAX_SIZE || '1000', 10),

    // Feature Flags
    enableArtworkLookup: process.env.ENABLE_ARTWORK_LOOKUP !== 'false',
    enableLibrarySearch: process.env.ENABLE_LIBRARY_SEARCH !== 'false',

    // Search behavior
    maxSearchResults: parseInt(process.env.MAX_SEARCH_RESULTS || '5', 10),
    artistSimilarityThreshold: parseFloat(process.env.ARTIST_SIMILARITY_THRESHOLD || '0.85'),
  };
}

/**
 * Validate that required configuration is present.
 * Returns an array of error messages for missing/invalid config.
 */
export function validateConfig(config: RequestLineConfig): string[] {
  const errors: string[] = [];

  // AI parsing is mandatory according to the plan
  if (!config.groqApiKey) {
    errors.push('GROQ_API_KEY is required for AI parsing');
  }

  // Discogs is optional but warn if not configured
  if (!config.discogsApiKey || !config.discogsApiSecret) {
    console.warn('[RequestLine Config] DISCOGS_API_KEY or DISCOGS_API_SECRET not set - artwork lookup and compilation search will be disabled');
  }

  return errors;
}

/**
 * Check if AI parsing is available.
 */
export function isParsingEnabled(config: RequestLineConfig): boolean {
  return !!config.groqApiKey;
}

/**
 * Check if Discogs integration is available.
 */
export function isDiscogsEnabled(config: RequestLineConfig): boolean {
  return !!(config.discogsApiKey && config.discogsApiSecret);
}

/**
 * Singleton config instance.
 */
let _config: RequestLineConfig | null = null;

/**
 * Get the configuration, loading it if necessary.
 */
export function getConfig(): RequestLineConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Reset the configuration (useful for testing).
 */
export function resetConfig(): void {
  _config = null;
}
