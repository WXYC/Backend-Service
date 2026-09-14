/**
 * Unit tests for the rotation-cards CRUD surface (BS#2472):
 * `listRotationCardsFromDB`, `addRotationCard`, `renameRotationCard`,
 * `deleteRotationCardFromDB`.
 */

import { jest } from '@jest/globals';
import { db, createMockQueryChain, rotation, rotation_cards } from '../../mocks/database.mock';

import {
  listRotationCardsFromDB,
  addRotationCard,
  renameRotationCard,
  deleteRotationCardFromDB,
} from '../../../apps/backend/services/library.service';

describe('listRotationCardsFromDB (BS#2472)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('is one grouped query: SELECT ... LEFT JOIN rotation ... GROUP BY', async () => {
    const rows = [{ id: 1, bin: 'M', number: 1, name: null, active_count: 3 }];
    const selectChain = createMockQueryChain();
    selectChain.orderBy = jest.fn().mockResolvedValue(rows);
    db.select.mockReturnValue(selectChain);

    const result = await listRotationCardsFromDB();

    expect(result).toBe(rows);
    expect(selectChain.from).toHaveBeenCalledWith(rotation_cards);
    expect(selectChain.leftJoin).toHaveBeenCalledTimes(1);
    expect(selectChain.leftJoin.mock.calls[0][0]).toBe(rotation);
    expect(selectChain.groupBy).toHaveBeenCalledWith(rotation_cards.id);
  });
});

describe('addRotationCard (BS#2472)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('assigns number = 1 for a bin with no existing cards', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    const insertChain = createMockQueryChain([{ id: 1, bin: 'M', number: 1, name: null }]);
    db.insert.mockReturnValue(insertChain);

    await addRotationCard('M', undefined);

    expect(insertChain.values).toHaveBeenCalledWith({ bin: 'M', number: 1, name: null });
  });

  test('assigns number = max + 1 for a bin with existing cards', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ number: 4 }]);
    db.select.mockReturnValue(selectChain);

    const insertChain = createMockQueryChain([{ id: 2, bin: 'M', number: 5, name: 'Front row' }]);
    db.insert.mockReturnValue(insertChain);

    await addRotationCard('M', 'Front row');

    expect(insertChain.values).toHaveBeenCalledWith({ bin: 'M', number: 5, name: 'Front row' });
  });
});

describe('renameRotationCard (BS#2472)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sets name and returns the updated row', async () => {
    const updateChain = createMockQueryChain([{ id: 1, bin: 'M', number: 1, name: 'New name' }]);
    db.update.mockReturnValue(updateChain);

    const result = await renameRotationCard(1, 'New name');

    expect(db.update).toHaveBeenCalledWith(rotation_cards);
    expect(updateChain.set).toHaveBeenCalledWith({ name: 'New name' });
    expect(result).toEqual({ id: 1, bin: 'M', number: 1, name: 'New name' });
  });

  test('returns undefined when no row matched', async () => {
    const updateChain = createMockQueryChain([]);
    db.update.mockReturnValue(updateChain);

    const result = await renameRotationCard(999, 'x');

    expect(result).toBeUndefined();
  });
});

describe('deleteRotationCardFromDB (BS#2472)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('not_found when the card does not exist', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'not_found' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  test('not_last_in_bin when a higher-numbered sibling card exists', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ bin: 'M', number: 1 }]);
    // First terminal .where() call (after the card lookup) is the MAX(number) query.
    selectChain.where = jest
      .fn()
      .mockReturnValueOnce(selectChain)
      .mockResolvedValueOnce([{ maxNumber: 2 }]);
    db.select.mockReturnValue(selectChain);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'not_last_in_bin' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  test('has_active_rows when the highest-numbered card still has active rotation rows', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ bin: 'M', number: 2 }]);
    selectChain.where = jest
      .fn()
      .mockReturnValueOnce(selectChain) // card lookup, intermediate
      .mockResolvedValueOnce([{ maxNumber: 2 }]) // MAX(number) query
      .mockResolvedValueOnce([{ activeCount: 3 }]); // active-row count query
    db.select.mockReturnValue(selectChain);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'has_active_rows', activeCount: 3 });
    expect(db.delete).not.toHaveBeenCalled();
  });

  test('deleted when the card is last-in-bin and has zero active rows', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ bin: 'M', number: 2 }]);
    selectChain.where = jest
      .fn()
      .mockReturnValueOnce(selectChain)
      .mockResolvedValueOnce([{ maxNumber: 2 }])
      .mockResolvedValueOnce([{ activeCount: 0 }]);
    db.select.mockReturnValue(selectChain);

    const deleteChain = createMockQueryChain([]);
    db.delete.mockReturnValue(deleteChain);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'deleted' });
    expect(db.delete).toHaveBeenCalledWith(rotation_cards);
  });
});
