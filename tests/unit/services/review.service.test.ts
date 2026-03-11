// Mock dependencies before importing the service
jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    execute: jest.fn().mockReturnThis(),
  },
  reviews: { album_id: 'album_id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
  desc: jest.fn((col) => ({ desc: col })),
}));

import { getReviewByAlbumId, upsertReview } from '../../../apps/backend/services/review.service';
import { db } from '@wxyc/database';

// Build a chainable mock from the db mock
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
};

function setUpChain() {
  const mockDb = db as unknown as MockDb;
  // Each chainable method returns the same object
  mockDb.from = jest.fn().mockReturnValue(mockDb);
  mockDb.where = jest.fn().mockReturnValue(mockDb);
  mockDb.limit = jest.fn().mockResolvedValue([]);
  mockDb.values = jest.fn().mockReturnValue(mockDb);
  mockDb.set = jest.fn().mockReturnValue(mockDb);
  mockDb.returning = jest.fn().mockResolvedValue([]);

  // select/insert/update return the chainable object
  mockDb.select.mockReturnValue(mockDb);
  mockDb.insert.mockReturnValue(mockDb);
  mockDb.update.mockReturnValue(mockDb);

  return mockDb;
}

describe('review.service', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = setUpChain();
  });

  describe('getReviewByAlbumId', () => {
    it('returns a review when found', async () => {
      const mockReview = {
        id: 1,
        album_id: 42,
        review: 'Great album!',
        author: 'DJ Test',
        add_date: '2024-01-15',
        last_modified: new Date('2024-01-15'),
      };

      mockDb.limit.mockResolvedValue([mockReview]);

      const result = await getReviewByAlbumId(42);

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockReview);
    });

    it('returns undefined when no review is found', async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await getReviewByAlbumId(999);

      expect(result).toBeUndefined();
    });
  });

  describe('upsertReview', () => {
    it('calls insert with onConflictDoUpdate', async () => {
      const mockResult = {
        id: 1,
        album_id: 42,
        review: 'Updated review',
        author: 'DJ Updated',
        add_date: '2024-01-15',
        last_modified: new Date(),
      };

      const onConflictDoUpdate = jest.fn().mockReturnValue(mockDb);
      mockDb.values.mockReturnValue({ onConflictDoUpdate });
      onConflictDoUpdate.mockReturnValue(mockDb);
      mockDb.returning.mockResolvedValue([mockResult]);

      const result = await upsertReview(42, 'Updated review', 'DJ Updated');

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalled();
      expect(onConflictDoUpdate).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('passes null for author when not provided', async () => {
      const mockResult = {
        id: 1,
        album_id: 42,
        review: 'No author review',
        author: null,
        add_date: '2024-01-15',
        last_modified: new Date(),
      };

      const onConflictDoUpdate = jest.fn().mockReturnValue(mockDb);
      mockDb.values.mockReturnValue({ onConflictDoUpdate });
      onConflictDoUpdate.mockReturnValue(mockDb);
      mockDb.returning.mockResolvedValue([mockResult]);

      const result = await upsertReview(42, 'No author review');

      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          album_id: 42,
          review: 'No author review',
          author: null,
        })
      );
      expect(result).toEqual(mockResult);
    });
  });
});
