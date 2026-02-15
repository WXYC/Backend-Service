import { db, createMockQueryChain, labels } from '../../mocks/database.mock';

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// Import after mocks are set up (module resolution uses moduleNameMapper)
import {
  getAllLabels,
  getLabelById,
  createLabel,
  searchLabels,
} from '../../../apps/backend/services/labels.service';

describe('labels.service', () => {
  describe('getAllLabels', () => {
    it('returns all labels', async () => {
      const mockLabels = [
        { id: 1, label_name: 'Merge Records', parent_label_id: null },
        { id: 2, label_name: 'Sub Pop', parent_label_id: null },
      ];
      const chain = createMockQueryChain(mockLabels);
      // select().from() chain resolves via the last chainable method
      // For select queries without returning(), the chain itself resolves
      (db.select as jest.Mock).mockReturnValue(chain);
      chain.from = jest.fn().mockResolvedValue(mockLabels);

      const result = await getAllLabels();

      expect(result).toEqual(mockLabels);
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe('getLabelById', () => {
    it('returns a label by id', async () => {
      const mockLabel = { id: 1, label_name: 'Merge Records', parent_label_id: null };
      const chain = createMockQueryChain([mockLabel]);
      (db.select as jest.Mock).mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockLabel]);

      const result = await getLabelById(1);

      expect(result).toEqual(mockLabel);
    });

    it('returns undefined when label not found', async () => {
      const chain = createMockQueryChain([]);
      (db.select as jest.Mock).mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([]);

      const result = await getLabelById(999);

      expect(result).toBeUndefined();
    });
  });

  describe('createLabel', () => {
    it('inserts and returns a new label', async () => {
      const mockLabel = { id: 1, label_name: 'Merge Records', parent_label_id: null };
      const chain = createMockQueryChain([mockLabel]);
      (db.insert as jest.Mock).mockReturnValue(chain);

      const result = await createLabel('Merge Records');

      expect(result).toEqual(mockLabel);
      expect(db.insert).toHaveBeenCalled();
    });

    it('returns existing label on duplicate name (upsert)', async () => {
      const mockLabel = { id: 1, label_name: 'Merge Records', parent_label_id: null };
      const chain = createMockQueryChain([mockLabel]);
      (db.insert as jest.Mock).mockReturnValue(chain);
      // onConflictDoNothing returns the chain, then we select
      chain.onConflictDoNothing = jest.fn().mockReturnValue(chain);

      const result = await createLabel('Merge Records');

      expect(result).toEqual(mockLabel);
    });

    it('sets parent_label_id when provided', async () => {
      const mockLabel = { id: 2, label_name: 'Domino USA', parent_label_id: 1 };
      const chain = createMockQueryChain([mockLabel]);
      (db.insert as jest.Mock).mockReturnValue(chain);

      const result = await createLabel('Domino USA', 1);

      expect(result).toEqual(mockLabel);
      expect(result.parent_label_id).toBe(1);
    });
  });

  describe('searchLabels', () => {
    it('filters labels by name prefix', async () => {
      const mockLabels = [
        { id: 1, label_name: 'Merge Records', parent_label_id: null },
      ];
      (db.execute as jest.Mock).mockResolvedValue({ rows: mockLabels });

      const result = await searchLabels('Merge');

      expect(result).toEqual(mockLabels);
      expect(db.execute).toHaveBeenCalled();
    });

    it('returns empty array when no matches', async () => {
      (db.execute as jest.Mock).mockResolvedValue({ rows: [] });

      const result = await searchLabels('Nonexistent');

      expect(result).toEqual([]);
    });
  });
});
