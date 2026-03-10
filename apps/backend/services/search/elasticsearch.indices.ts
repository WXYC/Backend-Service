import { getElasticsearchClient } from './elasticsearch.client.js';

const INDEX_BASE_NAME = 'wxyc_library';

export const LIBRARY_INDEX_MAPPING = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    properties: {
      id: { type: 'integer' },
      artist_name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      alphabetical_name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      album_title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      label: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      genre_name: { type: 'keyword' },
      format_name: { type: 'keyword' },
      rotation_bin: { type: 'keyword' },
      code_letters: { type: 'keyword' },
      code_artist_number: { type: 'integer' },
      code_number: { type: 'integer' },
      add_date: { type: 'date' },
    },
  },
} as const;

/**
 * Returns the index name, honoring the optional ELASTICSEARCH_INDEX_PREFIX
 * env var for test isolation (e.g., `ci_wxyc_library`).
 */
export function getLibraryIndexName(): string {
  const prefix = process.env.ELASTICSEARCH_INDEX_PREFIX ?? '';
  return `${prefix}${INDEX_BASE_NAME}`;
}

/**
 * Idempotently creates the library index if it does not already exist.
 * Safe to call at startup — does nothing when ES is disabled or the index exists.
 */
export async function ensureLibraryIndex(): Promise<void> {
  const client = getElasticsearchClient();
  if (!client) return;

  const indexName = getLibraryIndexName();
  const exists = await client.indices.exists({ index: indexName });

  if (!exists) {
    await client.indices.create({
      index: indexName,
      body: LIBRARY_INDEX_MAPPING,
    });
    console.log(`[Elasticsearch] Created index '${indexName}'`);
  }
}
