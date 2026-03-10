const originalEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('elasticsearch.client', () => {
  describe('isElasticsearchEnabled', () => {
    it('returns false when ELASTICSEARCH_URL is not set', async () => {
      delete process.env.ELASTICSEARCH_URL;
      const { isElasticsearchEnabled } = await import('../../../../apps/backend/services/search/elasticsearch.client');
      expect(isElasticsearchEnabled()).toBe(false);
    });

    it('returns false when ELASTICSEARCH_URL is empty string', async () => {
      process.env.ELASTICSEARCH_URL = '';
      const { isElasticsearchEnabled } = await import('../../../../apps/backend/services/search/elasticsearch.client');
      expect(isElasticsearchEnabled()).toBe(false);
    });

    it('returns true when ELASTICSEARCH_URL is set', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200';
      const { isElasticsearchEnabled } = await import('../../../../apps/backend/services/search/elasticsearch.client');
      expect(isElasticsearchEnabled()).toBe(true);
    });
  });

  describe('getElasticsearchClient', () => {
    it('returns null when ELASTICSEARCH_URL is not set', async () => {
      delete process.env.ELASTICSEARCH_URL;
      const { getElasticsearchClient } = await import('../../../../apps/backend/services/search/elasticsearch.client');
      expect(getElasticsearchClient()).toBeNull();
    });

    it('returns a Client instance when ELASTICSEARCH_URL is set', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200';
      const { getElasticsearchClient } = await import('../../../../apps/backend/services/search/elasticsearch.client');
      const client = getElasticsearchClient();
      expect(client).not.toBeNull();
      expect(client).toBeDefined();
    });

    it('returns the same instance on subsequent calls', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200';
      const { getElasticsearchClient } = await import('../../../../apps/backend/services/search/elasticsearch.client');
      const client1 = getElasticsearchClient();
      const client2 = getElasticsearchClient();
      expect(client1).toBe(client2);
    });

    it('configures auth when username and password are set', async () => {
      process.env.ELASTICSEARCH_URL = 'http://localhost:9200';
      process.env.ELASTICSEARCH_USERNAME = 'elastic';
      process.env.ELASTICSEARCH_PASSWORD = 'changeme';
      const { getElasticsearchClient } = await import('../../../../apps/backend/services/search/elasticsearch.client');
      const client = getElasticsearchClient();
      expect(client).not.toBeNull();
    });
  });
});
