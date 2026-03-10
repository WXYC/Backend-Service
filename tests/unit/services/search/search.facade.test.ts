import { jest } from '@jest/globals';
import type { LibraryArtistViewEntry } from '@wxyc/database';
import type { EnrichedLibraryResult } from '../../../../apps/backend/services/requestLine/types';

// Mock the ES client module
const mockIsEnabled = jest.fn<() => boolean>();
jest.mock('../../../../apps/backend/services/search/elasticsearch.client', () => ({
  isElasticsearchEnabled: mockIsEnabled,
}));

// Mock ES search functions
const mockSearchLibraryES = jest.fn<(...args: unknown[]) => Promise<LibraryArtistViewEntry[]>>();
const mockFindSimilarArtistES = jest.fn<(...args: unknown[]) => Promise<string | null>>();
const mockSearchAlbumsByTitleES = jest.fn<(...args: unknown[]) => Promise<LibraryArtistViewEntry[]>>();
const mockSearchByArtistES = jest.fn<(...args: unknown[]) => Promise<LibraryArtistViewEntry[]>>();
jest.mock('../../../../apps/backend/services/search/elasticsearch.search', () => ({
  searchLibraryES: mockSearchLibraryES,
  findSimilarArtistES: mockFindSimilarArtistES,
  searchAlbumsByTitleES: mockSearchAlbumsByTitleES,
  searchByArtistES: mockSearchByArtistES,
}));

// Mock pg_trgm functions from library.service
const mockPgTrgmSearchLibrary = jest.fn<(...args: unknown[]) => Promise<EnrichedLibraryResult[]>>();
const mockPgTrgmFindSimilarArtist = jest.fn<(...args: unknown[]) => Promise<string | null>>();
const mockPgTrgmSearchAlbumsByTitle = jest.fn<(...args: unknown[]) => Promise<EnrichedLibraryResult[]>>();
const mockPgTrgmSearchByArtist = jest.fn<(...args: unknown[]) => Promise<EnrichedLibraryResult[]>>();
jest.mock('../../../../apps/backend/services/library.service', () => ({
  pgTrgmSearchLibrary: mockPgTrgmSearchLibrary,
  pgTrgmFindSimilarArtist: mockPgTrgmFindSimilarArtist,
  pgTrgmSearchAlbumsByTitle: mockPgTrgmSearchAlbumsByTitle,
  pgTrgmSearchByArtist: mockPgTrgmSearchByArtist,
}));

// Mock enrichLibraryResult — just passes through with stub fields
jest.mock('../../../../apps/backend/services/requestLine/types', () => ({
  enrichLibraryResult: jest.fn((result: Record<string, unknown>) => ({
    ...result,
    callNumber: 'STUB',
    libraryUrl: 'STUB',
  })),
}));

import {
  searchLibrary,
  findSimilarArtist,
  searchAlbumsByTitle,
  searchByArtist,
} from '../../../../apps/backend/services/search/index';

const sampleESResult: LibraryArtistViewEntry = {
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
  add_date: new Date('2024-01-15'),
};

const samplePgResult: EnrichedLibraryResult = {
  id: 42,
  title: 'Segundo',
  artist: 'Juana Molina',
  alphabeticalName: 'Molina, Juana',
  codeLetters: 'RO',
  codeArtistNumber: 5,
  codeNumber: 2,
  genre: 'Rock',
  format: 'CD',
  callNumber: 'Rock CD RO 5/2',
  libraryUrl: 'http://www.wxyc.info/wxycdb/libraryRelease?id=42',
};

describe('search facade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('searchLibrary', () => {
    it('routes to ES when enabled and healthy', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockSearchLibraryES.mockResolvedValue([sampleESResult]);

      const results = await searchLibrary('Juana Molina');

      expect(mockSearchLibraryES).toHaveBeenCalledWith('Juana Molina', undefined, undefined, 5);
      expect(mockPgTrgmSearchLibrary).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('falls back to pg_trgm when ES throws', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockSearchLibraryES.mockRejectedValue(new Error('ES connection refused'));
      mockPgTrgmSearchLibrary.mockResolvedValue([samplePgResult]);

      const results = await searchLibrary('Juana Molina');

      expect(mockSearchLibraryES).toHaveBeenCalled();
      expect(mockPgTrgmSearchLibrary).toHaveBeenCalledWith('Juana Molina', undefined, undefined, 5);
      expect(results).toEqual([samplePgResult]);
    });

    it('routes directly to pg_trgm when ES is disabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      mockPgTrgmSearchLibrary.mockResolvedValue([samplePgResult]);

      const results = await searchLibrary('Juana Molina');

      expect(mockSearchLibraryES).not.toHaveBeenCalled();
      expect(mockPgTrgmSearchLibrary).toHaveBeenCalledWith('Juana Molina', undefined, undefined, 5);
      expect(results).toEqual([samplePgResult]);
    });

    it('passes artist and title parameters through', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockSearchLibraryES.mockResolvedValue([]);

      await searchLibrary(undefined, 'Stereolab', 'Aluminum Tunes', 10);

      expect(mockSearchLibraryES).toHaveBeenCalledWith(undefined, 'Stereolab', 'Aluminum Tunes', 10);
    });
  });

  describe('findSimilarArtist', () => {
    it('routes to ES when enabled', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockFindSimilarArtistES.mockResolvedValue('Juana Molina');

      const result = await findSimilarArtist('Juana Mollina');

      expect(mockFindSimilarArtistES).toHaveBeenCalledWith('Juana Mollina', 0.85);
      expect(mockPgTrgmFindSimilarArtist).not.toHaveBeenCalled();
      expect(result).toBe('Juana Molina');
    });

    it('falls back to pg_trgm when ES throws', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockFindSimilarArtistES.mockRejectedValue(new Error('timeout'));
      mockPgTrgmFindSimilarArtist.mockResolvedValue('Juana Molina');

      const result = await findSimilarArtist('Juana Mollina');

      expect(mockPgTrgmFindSimilarArtist).toHaveBeenCalledWith('Juana Mollina', 0.85);
      expect(result).toBe('Juana Molina');
    });

    it('routes to pg_trgm when ES is disabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      mockPgTrgmFindSimilarArtist.mockResolvedValue(null);

      await findSimilarArtist('Juana Molina');

      expect(mockFindSimilarArtistES).not.toHaveBeenCalled();
      expect(mockPgTrgmFindSimilarArtist).toHaveBeenCalled();
    });
  });

  describe('searchAlbumsByTitle', () => {
    it('routes to ES when enabled', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockSearchAlbumsByTitleES.mockResolvedValue([sampleESResult]);

      const results = await searchAlbumsByTitle('Segundo');

      expect(mockSearchAlbumsByTitleES).toHaveBeenCalledWith('Segundo', 5);
      expect(mockPgTrgmSearchAlbumsByTitle).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('falls back to pg_trgm when ES throws', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockSearchAlbumsByTitleES.mockRejectedValue(new Error('ES down'));
      mockPgTrgmSearchAlbumsByTitle.mockResolvedValue([samplePgResult]);

      const results = await searchAlbumsByTitle('Segundo');

      expect(mockPgTrgmSearchAlbumsByTitle).toHaveBeenCalledWith('Segundo', 5);
      expect(results).toEqual([samplePgResult]);
    });
  });

  describe('searchByArtist', () => {
    it('routes to ES when enabled', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockSearchByArtistES.mockResolvedValue([sampleESResult]);

      const results = await searchByArtist('Juana Molina');

      expect(mockSearchByArtistES).toHaveBeenCalledWith('Juana Molina', 5);
      expect(mockPgTrgmSearchByArtist).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('falls back to pg_trgm when ES throws', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockSearchByArtistES.mockRejectedValue(new Error('ES down'));
      mockPgTrgmSearchByArtist.mockResolvedValue([samplePgResult]);

      const results = await searchByArtist('Juana Molina');

      expect(mockPgTrgmSearchByArtist).toHaveBeenCalledWith('Juana Molina', 5);
      expect(results).toEqual([samplePgResult]);
    });
  });
});
