import { jest } from '@jest/globals';

// Mock ES sync before importing the service
const mockIndexLibraryDocumentById = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../apps/backend/services/search/elasticsearch.sync', () => ({
  indexLibraryDocumentById: mockIndexLibraryDocumentById,
}));

// Build a chainable mock DB
const mockReturning = jest.fn();
const mockValues = jest.fn().mockReturnValue({ returning: mockReturning });
const mockInsert = jest.fn().mockReturnValue({ values: mockValues });

const mockSet = jest.fn();
const mockUpdateWhere = jest.fn().mockReturnValue({ returning: mockReturning });
mockSet.mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });

jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    insert: mockInsert,
    update: mockUpdate,
    delete: jest.fn().mockReturnThis(),
  },
  library: {},
  artists: {},
  genres: {},
  format: {},
  rotation: {},
  library_artist_view: {},
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  and: jest.fn((...args: unknown[]) => ({ and: args })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
  desc: jest.fn((col) => ({ desc: col })),
}));

import { isISODate, insertAlbum, addToRotation, killRotationInDB } from '../../../apps/backend/services/library.service';

describe('library.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isISODate', () => {
    it('returns true for valid ISO date format YYYY-MM-DD', () => {
      expect(isISODate('2024-01-15')).toBe(true);
      expect(isISODate('2000-12-31')).toBe(true);
      expect(isISODate('1999-06-01')).toBe(true);
    });

    it('returns false for invalid formats', () => {
      expect(isISODate('01-15-2024')).toBe(false); // MM-DD-YYYY
      expect(isISODate('15/01/2024')).toBe(false); // DD/MM/YYYY
      expect(isISODate('2024/01/15')).toBe(false); // YYYY/MM/DD
      expect(isISODate('January 15, 2024')).toBe(false);
      expect(isISODate('2024-1-15')).toBe(false); // single digit month
      expect(isISODate('2024-01-5')).toBe(false); // single digit day
    });

    it('returns false for empty or invalid strings', () => {
      expect(isISODate('')).toBe(false);
      expect(isISODate('not-a-date')).toBe(false);
      expect(isISODate('2024')).toBe(false);
      expect(isISODate('2024-01')).toBe(false);
    });

    it('returns true for edge case dates (format only, not validity)', () => {
      // Note: isISODate only checks format, not calendar validity
      expect(isISODate('2024-02-29')).toBe(true); // leap year
      expect(isISODate('2024-02-30')).toBe(true); // invalid day but correct format
      expect(isISODate('2024-13-01')).toBe(true); // invalid month but correct format
    });
  });

  describe('dual-write to Elasticsearch', () => {
    it('insertAlbum calls indexLibraryDocumentById with the inserted album ID', async () => {
      mockReturning.mockResolvedValue([{ id: 99, album_title: 'Segundo' }]);

      await insertAlbum({ artist_id: 1, genre_id: 1, format_id: 1, album_title: 'Segundo', label: 'Domino', code_number: 1 });

      expect(mockIndexLibraryDocumentById).toHaveBeenCalledWith(99);
    });

    it('addToRotation calls indexLibraryDocumentById with the album_id', async () => {
      mockReturning.mockResolvedValue([{ id: 5, album_id: 42, rotation_bin: 'H' }]);

      await addToRotation({ album_id: 42, rotation_bin: 'H' });

      expect(mockIndexLibraryDocumentById).toHaveBeenCalledWith(42);
    });

    it('killRotationInDB calls indexLibraryDocumentById with the album_id', async () => {
      mockReturning.mockResolvedValue([{ id: 5, album_id: 42, kill_date: '2024-06-01' }]);

      await killRotationInDB(5, '2024-06-01');

      expect(mockIndexLibraryDocumentById).toHaveBeenCalledWith(42);
    });

    it('insertAlbum still returns normally when sync fails', async () => {
      mockReturning.mockResolvedValue([{ id: 100, album_title: 'Moon Pix' }]);
      mockIndexLibraryDocumentById.mockRejectedValue(new Error('ES down'));

      const result = await insertAlbum({ artist_id: 2, genre_id: 1, format_id: 1, album_title: 'Moon Pix', label: 'Matador Records', code_number: 1 });

      expect(result).toEqual({ id: 100, album_title: 'Moon Pix' });
    });

    it('addToRotation still returns normally when sync fails', async () => {
      mockReturning.mockResolvedValue([{ id: 6, album_id: 43, rotation_bin: 'S' }]);
      mockIndexLibraryDocumentById.mockRejectedValue(new Error('ES down'));

      const result = await addToRotation({ album_id: 43, rotation_bin: 'S' });

      expect(result).toEqual({ id: 6, album_id: 43, rotation_bin: 'S' });
    });

    it('killRotationInDB still returns normally when sync fails', async () => {
      mockReturning.mockResolvedValue([{ id: 7, album_id: 44, kill_date: '2024-06-01' }]);
      mockIndexLibraryDocumentById.mockRejectedValue(new Error('ES down'));

      const result = await killRotationInDB(7, '2024-06-01');

      expect(result).toEqual({ id: 7, album_id: 44, kill_date: '2024-06-01' });
    });
  });
});
