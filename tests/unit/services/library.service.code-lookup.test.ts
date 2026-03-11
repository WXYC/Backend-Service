// Mock dependencies before importing the service
jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    execute: jest.fn().mockReturnThis(),
  },
  library: {},
  artists: {},
  genres: {},
  format: {},
  rotation: {},
  library_artist_view: {
    code_letters: 'code_letters',
    code_artist_number: 'code_artist_number',
    code_number: 'code_number',
    genre_name: 'genre_name',
  },
}));

jest.mock('drizzle-orm', () => ({
  and: jest.fn((...conditions) => ({ and: conditions })),
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
  desc: jest.fn((col) => ({ desc: col })),
}));

import { lookupByLibraryCode, updateAlbumFields } from '../../../apps/backend/services/library.service';
import { db } from '@wxyc/database';
import { and, eq } from 'drizzle-orm';

type MockDb = {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  values: jest.Mock;
  returning: jest.Mock;
  set: jest.Mock;
  _whereResolveValue: unknown[];
};

function setUpChain() {
  const mockDb = db as unknown as MockDb;
  mockDb._whereResolveValue = [];
  mockDb.from = jest.fn().mockReturnValue(mockDb);
  mockDb.limit = jest.fn().mockResolvedValue([]);
  mockDb.values = jest.fn().mockReturnValue(mockDb);
  mockDb.set = jest.fn().mockReturnValue(mockDb);
  mockDb.returning = jest.fn().mockResolvedValue([]);

  // where() returns a thenable that also has .returning() for chaining
  // This supports both:
  //   await db.select().from().where()          -- lookupByLibraryCode
  //   await db.update().set().where().returning() -- updateAlbumFields
  mockDb.where = jest.fn().mockImplementation(() => ({
    then: (resolve: (val: unknown) => void, reject?: (err: unknown) => void) =>
      Promise.resolve(mockDb._whereResolveValue).then(resolve, reject),
    returning: mockDb.returning,
  }));

  mockDb.select.mockReturnValue(mockDb);
  mockDb.insert.mockReturnValue(mockDb);
  mockDb.update.mockReturnValue(mockDb);

  return mockDb;
}

describe('library.service - code lookup and album update', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = setUpChain();
  });

  describe('lookupByLibraryCode', () => {
    it('queries with code_letters and code_artist_number', async () => {
      const mockResults = [
        {
          id: 1,
          code_letters: 'AB',
          code_artist_number: 5,
          code_number: 1,
          artist_name: 'Test Artist',
          album_title: 'Test Album',
          genre_name: 'Rock',
          format_name: 'CD',
          label: 'Test Label',
        },
      ];

      mockDb._whereResolveValue = mockResults;

      const result = await lookupByLibraryCode('AB', 5);

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
      expect(eq).toHaveBeenCalledWith('code_letters', 'AB');
      expect(eq).toHaveBeenCalledWith('code_artist_number', 5);
      expect(and).toHaveBeenCalled();
      expect(result).toEqual(mockResults);
    });

    it('filters by code_number when provided', async () => {
      mockDb._whereResolveValue = [];

      await lookupByLibraryCode('AB', 5, 3);

      expect(eq).toHaveBeenCalledWith('code_number', 3);
    });

    it('filters by genre_name when provided', async () => {
      mockDb._whereResolveValue = [];

      await lookupByLibraryCode('AB', 5, undefined, 'Rock');

      expect(eq).toHaveBeenCalledWith('genre_name', 'Rock');
    });

    it('returns empty array when no matches found', async () => {
      mockDb._whereResolveValue = [];

      const result = await lookupByLibraryCode('ZZ', 99);

      expect(result).toEqual([]);
    });
  });

  describe('updateAlbumFields', () => {
    it('updates only provided fields', async () => {
      const mockUpdated = {
        id: 42,
        album_title: 'Original Title',
        label: 'New Label',
        last_modified: new Date(),
      };

      mockDb.returning.mockResolvedValue([mockUpdated]);

      const result = await updateAlbumFields(42, { label: 'New Label' });

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'New Label',
        })
      );
      expect(result).toEqual(mockUpdated);
    });

    it('updates album_title when provided', async () => {
      const mockUpdated = {
        id: 42,
        album_title: 'New Title',
        label: 'Some Label',
        last_modified: new Date(),
      };

      mockDb.returning.mockResolvedValue([mockUpdated]);

      const result = await updateAlbumFields(42, { album_title: 'New Title' });

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          album_title: 'New Title',
        })
      );
      expect(result).toEqual(mockUpdated);
    });

    it('updates both label and album_title when both provided', async () => {
      const mockUpdated = {
        id: 42,
        album_title: 'New Title',
        label: 'New Label',
        last_modified: new Date(),
      };

      mockDb.returning.mockResolvedValue([mockUpdated]);

      const result = await updateAlbumFields(42, { label: 'New Label', album_title: 'New Title' });

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'New Label',
          album_title: 'New Title',
        })
      );
      expect(result).toEqual(mockUpdated);
    });
  });
});
