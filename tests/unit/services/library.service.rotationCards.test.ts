/**
 * Unit tests for the rotation-cards CRUD surface (BS#2472):
 * `listRotationCardsFromDB`, `addRotationCard`, `renameRotationCard`,
 * `deleteRotationCardFromDB`, and `addToRotation`'s card resolution
 * (newest-card defaulting + the card-bin invariant).
 */

import { jest } from '@jest/globals';
import { db, createMockQueryChain, rotation, rotation_cards } from '../../mocks/database.mock';

import {
  listRotationCardsFromDB,
  addRotationCard,
  renameRotationCard,
  deleteRotationCardFromDB,
  addToRotation,
  RotationCardBinMismatchError,
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

  // Per shared/database/src/sqlstate.ts: production rejections arrive as
  // drizzle's `DrizzleQueryError` wrapper with the driver error on `.cause`,
  // so the double builds the WRAPPED shape — a bare `{ code }` would keep a
  // classifier that reads only `error.code` green while it classifies
  // nothing in production.
  const wrappedUniqueViolation = () =>
    Object.assign(new Error('Failed query: insert into "rotation_cards" ...'), {
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    });

  test('retries once against a fresh MAX when the (bin, number) unique index rejects the INSERT', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest
      .fn()
      .mockResolvedValueOnce([{ number: 4 }])
      .mockResolvedValueOnce([{ number: 5 }]);
    db.select.mockReturnValue(selectChain);

    const losingInsert = createMockQueryChain();
    losingInsert.returning = jest.fn().mockRejectedValue(wrappedUniqueViolation());
    const winningInsert = createMockQueryChain([{ id: 9, bin: 'M', number: 6, name: null }]);
    db.insert.mockReturnValueOnce(losingInsert).mockReturnValueOnce(winningInsert);

    const card = await addRotationCard('M', undefined);

    expect(losingInsert.values).toHaveBeenCalledWith({ bin: 'M', number: 5, name: null });
    expect(winningInsert.values).toHaveBeenCalledWith({ bin: 'M', number: 6, name: null });
    expect(card).toEqual({ id: 9, bin: 'M', number: 6, name: null });
  });

  test('409s when the retry collides again', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ number: 4 }]);
    db.select.mockReturnValue(selectChain);

    const insertChain = createMockQueryChain();
    insertChain.returning = jest.fn().mockRejectedValue(wrappedUniqueViolation());
    db.insert.mockReturnValue(insertChain);

    await expect(addRotationCard('M', undefined)).rejects.toMatchObject({ statusCode: 409 });
    expect(insertChain.values).toHaveBeenCalledTimes(2);
  });

  test('rethrows a non-unique-violation INSERT failure without retrying', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ number: 4 }]);
    db.select.mockReturnValue(selectChain);

    const insertChain = createMockQueryChain();
    insertChain.returning = jest.fn().mockRejectedValue(new Error('connection reset'));
    db.insert.mockReturnValue(insertChain);

    await expect(addRotationCard('M', undefined)).rejects.toThrow('connection reset');
    expect(insertChain.values).toHaveBeenCalledTimes(1);
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

  test('deleted when the guarded DELETE matches — no classification reads run', async () => {
    // The guarded DELETE (raw SQL via tx.execute, RETURNING id) matched.
    db.execute.mockResolvedValueOnce([{ id: 1 }]);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'deleted' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  test('not_found when the card does not exist', async () => {
    // Guarded DELETE matches nothing (execute's default `[]`); the
    // classification lookup finds no card either.
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'not_found' });
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
  });

  test('409s when every guard passes on re-read yet the guarded DELETE matched nothing', async () => {
    // The double-race corner: a refusing fact existed at the DELETE's
    // snapshot and was itself removed before the classification reads. The
    // service refuses rather than fabricating a reason.
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ bin: 'M', number: 2 }]);
    selectChain.where = jest
      .fn()
      .mockReturnValueOnce(selectChain)
      .mockResolvedValueOnce([{ maxNumber: 2 }])
      .mockResolvedValueOnce([{ activeCount: 0 }]);
    db.select.mockReturnValue(selectChain);

    await expect(deleteRotationCardFromDB(1)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('concurrently'),
    });
  });
});

describe('addToRotation card resolution (BS#2472)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Uncatalogued adds (no `album_id`) keep these tests off the
  // library_identity → LML resolve path, which has its own suite
  // (`library.service.addToRotation.test.ts`).
  const UNCATALOGUED = { artist_name: 'Juana Molina', album_title: 'DOGA' };

  test("defaults a card-less add onto the bin's newest card", async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ id: 7 }]);
    db.select.mockReturnValue(selectChain);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: 7 }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'M', ...UNCATALOGUED });

    expect(selectChain.from).toHaveBeenCalledWith(rotation_cards);
    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.card_id).toBe(7);
  });

  test('a bin with no cards leaves the row unfiled', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: null }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'M', ...UNCATALOGUED });

    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.card_id).toBeUndefined();
  });

  test("accepts an explicit card_id whose card lives in the row's bin", async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ bin: 'M' }]);
    db.select.mockReturnValue(selectChain);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: 7 }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'M', card_id: 7, ...UNCATALOGUED });

    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.card_id).toBe(7);
  });

  test('bin agreement is checked against the NORMALIZED request bin', async () => {
    // The controller validates the bin's spelling but forwards it raw, so a
    // lowercase 'm' must still match a card filed in 'M'.
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ bin: 'M' }]);
    db.select.mockReturnValue(selectChain);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: 7 }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'm' as 'M', card_id: 7, ...UNCATALOGUED });

    expect(insertChain.values).toHaveBeenCalled();
  });

  test('throws RotationCardBinMismatchError when the card lives in a different bin', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([{ bin: 'S' }]);
    db.select.mockReturnValue(selectChain);

    await expect(addToRotation({ rotation_bin: 'M', card_id: 7, ...UNCATALOGUED })).rejects.toThrow(
      RotationCardBinMismatchError
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  test('404s a card_id that references no card', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    await expect(addToRotation({ rotation_bin: 'M', card_id: 999, ...UNCATALOGUED })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
