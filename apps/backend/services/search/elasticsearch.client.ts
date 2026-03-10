import { Client } from '@elastic/elasticsearch';

let client: Client | null = null;

/**
 * Returns true when Elasticsearch is configured via the ELASTICSEARCH_URL env var.
 */
export function isElasticsearchEnabled(): boolean {
  return !!process.env.ELASTICSEARCH_URL;
}

/**
 * Returns the singleton Elasticsearch client, or null when ES is disabled.
 *
 * Does NOT throw on missing config — callers use null to degrade gracefully.
 */
export function getElasticsearchClient(): Client | null {
  if (!isElasticsearchEnabled()) {
    return null;
  }

  if (!client) {
    const config: ConstructorParameters<typeof Client>[0] = {
      node: process.env.ELASTICSEARCH_URL,
      requestTimeout: 5000,
      maxRetries: 2,
    };

    if (process.env.ELASTICSEARCH_USERNAME && process.env.ELASTICSEARCH_PASSWORD) {
      config.auth = {
        username: process.env.ELASTICSEARCH_USERNAME,
        password: process.env.ELASTICSEARCH_PASSWORD,
      };
    }

    client = new Client(config);
  }

  return client;
}
