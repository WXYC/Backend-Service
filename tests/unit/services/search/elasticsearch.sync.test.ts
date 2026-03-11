import { jest } from '@jest/globals';

// Mock the ES client module
const mockIndex = jest.fn();
const mockDelete = jest.fn();
const mockBulk = jest.fn();
const mockGetClient = jest.fn();

jest.mock('../../../../apps/backend/services/search/elasticsearch.client', () => ({
  getElasticsearchClient: mockGetClient,
}));

const mockEnsureLibraryIndex = jest.fn();
const mockGetLibraryIndexName = jest.fn(() => 'wxyc_library');

jest.mock('../../../../apps/backend/services/search/elasticsearch.indices', () => ({
  ensureLibraryIndex: mockEnsureLibraryIndex,
  getLibraryIndexName: mockGetLibraryIndexName,
}));

// Mock @wxyc/database for the view query
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockWhere = jest.fn();
const mockLimit = jest.fn();

jest.mock('@wxyc/database', () => ({
  db: { select: mockSelect },
  library_artist_view: { id: 'id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
}));

import {
  indexLibraryDocumentById,
  removeLibraryDocument,
  bulkIndexLibrary,
} from '../../../../apps/backend/services/search/elasticsearch.sync';

const sampleViewEntry = {
  id: 42,
  artist_name: 'Juana Molina',
  alphabetical_name: 'Molina, Juana',
  album_title: 'Segundo',
  label: 'Domino',
  genre_name: 'Rock',
  format_name: 'CD',
  rotation_bin: null as string | null,
  code_letters: 'RO',
  code_artist_number: 5,
  code_number: 2,
  add_date: new Date('2024-01-15'),
};

function setUpClient() {
  const client = { index: mockIndex, delete: mockDelete, bulk: mockBulk };
  mockGetClient.mockReturnValue(client);
  return client;
}

function setUpNullClient() {
  mockGetClient.mockReturnValue(null);
}

function setUpViewQuery(result: unknown[]) {
  mockLimit.mockResolvedValue(result);
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
}

function setUpViewQueryAll(result: unknown[]) {
  mockFrom.mockResolvedValue(result);
  mockSelect.mockReturnValue({ from: mockFrom });
}

describe('elasticsearch.sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('indexLibraryDocumentById', () => {
    it('queries view by album ID and indexes the document', async () => {
      setUpClient();
      setUpViewQuery([sampleViewEntry]);
      mockIndex.mockResolvedValue({});

      await indexLibraryDocumentById(42);

      expect(mockSelect).toHaveBeenCalled();
      expect(mockIndex).toHaveBeenCalledWith({
        index: 'wxyc_library',
        id: '42',
        body: expect.objectContaining({
          id: 42,
          artist_name: 'Juana Molina',
          album_title: 'Segundo',
          add_date: expect.any(String),
        }),
      });
    });

    it('converts add_date to ISO string for ES date mapping', async () => {
      setUpClient();
      setUpViewQuery([sampleViewEntry]);
      mockIndex.mockResolvedValue({});

      await indexLibraryDocumentById(42);

      const indexCall = mockIndex.mock.calls[0][0] as { body: { add_date: string } };
      expect(typeof indexCall.body.add_date).toBe('string');
      expect(indexCall.body.add_date).toContain('2024-01-15');
    });

    it('includes rotation_bin when present', async () => {
      setUpClient();
      const entryWithRotation = { ...sampleViewEntry, rotation_bin: 'H' };
      setUpViewQuery([entryWithRotation]);
      mockIndex.mockResolvedValue({});

      await indexLibraryDocumentById(42);

      const indexCall = mockIndex.mock.calls[0][0] as { body: { rotation_bin: string } };
      expect(indexCall.body.rotation_bin).toBe('H');
    });

    it('includes null rotation_bin when absent', async () => {
      setUpClient();
      setUpViewQuery([sampleViewEntry]);
      mockIndex.mockResolvedValue({});

      await indexLibraryDocumentById(42);

      const indexCall = mockIndex.mock.calls[0][0] as { body: { rotation_bin: string | null } };
      expect(indexCall.body.rotation_bin).toBeNull();
    });

    it('logs warning when album not found in view', async () => {
      setUpClient();
      setUpViewQuery([]);
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await indexLibraryDocumentById(999);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('999'));
      expect(mockIndex).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('no-ops when ES client is null', async () => {
      setUpNullClient();

      await indexLibraryDocumentById(42);

      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockIndex).not.toHaveBeenCalled();
    });

    it('logs errors but does not throw', async () => {
      setUpClient();
      setUpViewQuery([sampleViewEntry]);
      mockIndex.mockRejectedValue(new Error('ES connection refused'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(indexLibraryDocumentById(42)).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('removeLibraryDocument', () => {
    it('deletes document by string ID', async () => {
      setUpClient();
      mockDelete.mockResolvedValue({});

      await removeLibraryDocument(42);

      expect(mockDelete).toHaveBeenCalledWith({
        index: 'wxyc_library',
        id: '42',
      });
    });

    it('ignores 404 errors', async () => {
      setUpClient();
      const notFoundError = Object.assign(new Error('not found'), {
        meta: { statusCode: 404 },
      });
      mockDelete.mockRejectedValue(notFoundError);

      await expect(removeLibraryDocument(42)).resolves.toBeUndefined();
    });

    it('logs non-404 errors but does not throw', async () => {
      setUpClient();
      mockDelete.mockRejectedValue(new Error('ES connection refused'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(removeLibraryDocument(42)).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('no-ops when ES client is null', async () => {
      setUpNullClient();

      await removeLibraryDocument(42);

      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('bulkIndexLibrary', () => {
    it('calls ensureLibraryIndex before indexing', async () => {
      setUpClient();
      setUpViewQueryAll([]);
      mockEnsureLibraryIndex.mockResolvedValue(undefined);

      await bulkIndexLibrary();

      expect(mockEnsureLibraryIndex).toHaveBeenCalled();
    });

    it('builds bulk operations from view rows', async () => {
      setUpClient();
      setUpViewQueryAll([sampleViewEntry]);
      mockEnsureLibraryIndex.mockResolvedValue(undefined);
      mockBulk.mockResolvedValue({ errors: false, items: [{}] });

      const result = await bulkIndexLibrary();

      expect(mockBulk).toHaveBeenCalledWith({
        operations: expect.arrayContaining([
          { index: { _index: 'wxyc_library', _id: '42' } },
          expect.objectContaining({ id: 42, artist_name: 'Juana Molina' }),
        ]),
      });
      expect(result).toEqual({ indexed: 1, errors: 0 });
    });

    it('includes rotation_bin in bulk-indexed documents', async () => {
      setUpClient();
      const entryWithRotation = { ...sampleViewEntry, rotation_bin: 'S' };
      setUpViewQueryAll([entryWithRotation]);
      mockEnsureLibraryIndex.mockResolvedValue(undefined);
      mockBulk.mockResolvedValue({ errors: false, items: [{}] });

      await bulkIndexLibrary();

      const bulkCall = mockBulk.mock.calls[0][0] as { operations: Array<Record<string, unknown>> };
      const docBody = bulkCall.operations[1] as { rotation_bin: string };
      expect(docBody.rotation_bin).toBe('S');
    });

    it('handles empty library', async () => {
      setUpClient();
      setUpViewQueryAll([]);
      mockEnsureLibraryIndex.mockResolvedValue(undefined);

      const result = await bulkIndexLibrary();

      expect(mockBulk).not.toHaveBeenCalled();
      expect(result).toEqual({ indexed: 0, errors: 0 });
    });

    it('returns error count from bulk response', async () => {
      setUpClient();
      const entries = Array.from({ length: 3 }, (_, i) => ({
        ...sampleViewEntry,
        id: i + 1,
      }));
      setUpViewQueryAll(entries);
      mockEnsureLibraryIndex.mockResolvedValue(undefined);
      mockBulk.mockResolvedValue({
        errors: true,
        items: [
          { index: { status: 200 } },
          { index: { status: 500, error: { reason: 'test' } } },
          { index: { status: 200 } },
        ],
      });

      const result = await bulkIndexLibrary();

      expect(result).toEqual({ indexed: 3, errors: 1 });
    });

    it('no-ops when ES client is null', async () => {
      setUpNullClient();

      const result = await bulkIndexLibrary();

      expect(mockEnsureLibraryIndex).not.toHaveBeenCalled();
      expect(mockBulk).not.toHaveBeenCalled();
      expect(result).toEqual({ indexed: 0, errors: 0 });
    });

    it('chunks large datasets into batches of 500', async () => {
      setUpClient();
      const entries = Array.from({ length: 1200 }, (_, i) => ({
        ...sampleViewEntry,
        id: i + 1,
      }));
      setUpViewQueryAll(entries);
      mockEnsureLibraryIndex.mockResolvedValue(undefined);
      mockBulk.mockResolvedValue({ errors: false, items: Array(500).fill({ index: { status: 200 } }) });

      await bulkIndexLibrary();

      // 1200 rows / 500 per batch = 3 bulk calls
      expect(mockBulk).toHaveBeenCalledTimes(3);
    });
  });
});
