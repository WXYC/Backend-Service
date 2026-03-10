import { jest } from '@jest/globals';

// Mock the client module
const mockSearch = jest.fn();
jest.mock('../../../../apps/backend/services/search/elasticsearch.client', () => ({
  getElasticsearchClient: jest.fn(() => ({
    search: mockSearch,
  })),
  isElasticsearchEnabled: jest.fn(() => true),
}));

jest.mock('../../../../apps/backend/services/search/elasticsearch.indices', () => ({
  getLibraryIndexName: jest.fn(() => 'wxyc_library'),
}));

import {
  searchLibraryES,
  findSimilarArtistES,
  searchAlbumsByTitleES,
  searchByArtistES,
} from '../../../../apps/backend/services/search/elasticsearch.search';

const sampleHit = {
  _source: {
    id: 42,
    artist_name: 'Juana Molina',
    alphabetical_name: 'Molina, Juana',
    album_title: 'Segundo',
    label: 'Domino',
    genre_name: 'Rock',
    format_name: 'CD',
    rotation_bin: null,
    code_letters: 'RO',
    code_artist_number: 5,
    code_number: 2,
    add_date: '2024-01-15',
  },
};

describe('elasticsearch.search', () => {
  beforeEach(() => {
    mockSearch.mockReset();
  });

  describe('searchLibraryES', () => {
    it('builds a multi_match query from a general query string', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [sampleHit] } });

      await searchLibraryES('Juana Molina');

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'wxyc_library',
          size: 5,
          body: expect.objectContaining({
            query: expect.objectContaining({
              multi_match: expect.objectContaining({
                query: 'Juana Molina',
                fuzziness: 'AUTO',
              }),
            }),
          }),
        })
      );
    });

    it('builds a bool query when artist and title are provided', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [sampleHit] } });

      await searchLibraryES(undefined, 'Juana Molina', 'Segundo');

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                should: expect.arrayContaining([
                  expect.objectContaining({ match: expect.objectContaining({ artist_name: expect.any(Object) }) }),
                  expect.objectContaining({ match: expect.objectContaining({ album_title: expect.any(Object) }) }),
                ]),
              }),
            }),
          }),
        })
      );
    });

    it('maps ES results to LibraryArtistViewEntry shape', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [sampleHit] } });

      const results = await searchLibraryES('Juana Molina');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 42,
        artist_name: 'Juana Molina',
        alphabetical_name: 'Molina, Juana',
        album_title: 'Segundo',
        label: 'Domino',
        genre_name: 'Rock',
        format_name: 'CD',
        rotation_bin: null,
        code_letters: 'RO',
        code_artist_number: 5,
        code_number: 2,
        add_date: '2024-01-15',
      });
    });

    it('returns empty array when no hits', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [] } });
      const results = await searchLibraryES('nonexistent');
      expect(results).toEqual([]);
    });

    it('respects custom limit parameter', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [] } });
      await searchLibraryES('test', undefined, undefined, 10);
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ size: 10 }));
    });

    it('returns empty array when no query, artist, or title provided', async () => {
      const results = await searchLibraryES();
      expect(results).toEqual([]);
      expect(mockSearch).not.toHaveBeenCalled();
    });
  });

  describe('findSimilarArtistES', () => {
    it('searches for similar artist names with fuzzy matching', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          hits: [
            {
              _source: { artist_name: 'Juana Molina' },
              _score: 5.2,
            },
          ],
        },
      });

      await findSimilarArtistES('Juana Mollina');

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              match: expect.objectContaining({
                artist_name: expect.objectContaining({
                  query: 'Juana Mollina',
                  fuzziness: 'AUTO',
                }),
              }),
            }),
          }),
        })
      );
    });

    it('returns corrected artist name when a different match is found', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          hits: [{ _source: { artist_name: 'Juana Molina' }, _score: 5.2 }],
        },
      });

      const result = await findSimilarArtistES('Juana Mollina');
      expect(result).toBe('Juana Molina');
    });

    it('returns null when the best match is the same name', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          hits: [{ _source: { artist_name: 'Juana Molina' }, _score: 5.2 }],
        },
      });

      const result = await findSimilarArtistES('Juana Molina');
      expect(result).toBeNull();
    });

    it('returns null when no matches found', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [] } });
      const result = await findSimilarArtistES('zzzznonexistent');
      expect(result).toBeNull();
    });
  });

  describe('searchAlbumsByTitleES', () => {
    it('searches albums by title with fuzzy matching', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [sampleHit] } });

      const results = await searchAlbumsByTitleES('Segundo');

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              match: expect.objectContaining({
                album_title: expect.objectContaining({
                  query: 'Segundo',
                  fuzziness: 'AUTO',
                }),
              }),
            }),
          }),
        })
      );
      expect(results).toHaveLength(1);
      expect(results[0].album_title).toBe('Segundo');
    });

    it('returns empty array when no matches', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [] } });
      const results = await searchAlbumsByTitleES('nonexistent');
      expect(results).toEqual([]);
    });
  });

  describe('searchByArtistES', () => {
    it('searches by artist name with fuzzy matching', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [sampleHit] } });

      const results = await searchByArtistES('Juana Molina');

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              match: expect.objectContaining({
                artist_name: expect.objectContaining({
                  query: 'Juana Molina',
                  fuzziness: 'AUTO',
                }),
              }),
            }),
          }),
        })
      );
      expect(results).toHaveLength(1);
      expect(results[0].artist_name).toBe('Juana Molina');
    });

    it('returns empty array when no matches', async () => {
      mockSearch.mockResolvedValue({ hits: { hits: [] } });
      const results = await searchByArtistES('nonexistent');
      expect(results).toEqual([]);
    });
  });
});
