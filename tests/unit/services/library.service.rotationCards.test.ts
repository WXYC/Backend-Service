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

  // The MAX read arrives at `tx.execute` as a raw FOR UPDATE statement —
  // the lock on the bin's top card must live in the same transaction as the
  // INSERT it protects (the create-side half of number contiguity: without
  // it, a concurrent top-card delete between MAX read and INSERT opens a
  // gap the 23505 retry can never see).

  test('assigns number = 1 for a bin with no existing cards', async () => {
    db.execute.mockResolvedValueOnce([]);
    const insertChain = createMockQueryChain([{ id: 1, bin: 'M', number: 1, name: null }]);
    db.insert.mockReturnValue(insertChain);

    await addRotationCard('M', undefined);

    expect(insertChain.values).toHaveBeenCalledWith({ bin: 'M', number: 1, name: null });
  });

  test('assigns number = max + 1 for a bin with existing cards, locking the top card across the INSERT', async () => {
    db.execute.mockResolvedValueOnce([{ number: 4 }]);
    const insertChain = createMockQueryChain([{ id: 2, bin: 'M', number: 5, name: 'Front row' }]);
    db.insert.mockReturnValue(insertChain);

    await addRotationCard('M', 'Front row');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.execute.mock.calls[0][0])).toMatch(/FOR UPDATE/);
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
    db.execute.mockResolvedValueOnce([{ number: 4 }]).mockResolvedValueOnce([{ number: 5 }]);
    const losingInsert = createMockQueryChain();
    losingInsert.returning = jest.fn().mockRejectedValue(wrappedUniqueViolation());
    const winningInsert = createMockQueryChain([{ id: 9, bin: 'M', number: 6, name: null }]);
    db.insert.mockReturnValueOnce(losingInsert).mockReturnValueOnce(winningInsert);

    const card = await addRotationCard('M', undefined);

    expect(losingInsert.values).toHaveBeenCalledWith({ bin: 'M', number: 5, name: null });
    expect(winningInsert.values).toHaveBeenCalledWith({ bin: 'M', number: 6, name: null });
    // Each attempt is its own transaction — the aborted loser can't leave
    // the retry running inside a failed transaction.
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(card).toEqual({ id: 9, bin: 'M', number: 6, name: null });
  });

  test('409s when the retry collides again', async () => {
    db.execute.mockResolvedValueOnce([{ number: 4 }]).mockResolvedValueOnce([{ number: 4 }]);
    const insertChain = createMockQueryChain();
    insertChain.returning = jest.fn().mockRejectedValue(wrappedUniqueViolation());
    db.insert.mockReturnValue(insertChain);

    await expect(addRotationCard('M', undefined)).rejects.toMatchObject({ statusCode: 409 });
    expect(insertChain.values).toHaveBeenCalledTimes(2);
  });

  test('rethrows a non-unique-violation INSERT failure without retrying', async () => {
    db.execute.mockResolvedValueOnce([{ number: 4 }]);
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

  // The transaction's raw statements arrive at `tx.execute` in a fixed
  // order: (1) the FOR UPDATE lock on the card row, (2) ONE combined
  // guard + DELETE + classification statement. The combination is the
  // point: a classification read in a separate statement takes a later
  // snapshot than the DELETE, so a refusing fact could vanish in between
  // and leave a refusal no contract reason describes. Sharing the snapshot
  // makes that state unrepresentable — every refusal names its guard.

  test('not_found when the lock SELECT finds no card — the DELETE never runs', async () => {
    db.execute.mockResolvedValueOnce([]);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'not_found' });
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  test('deleted when the single-statement guard passes — no further statements run', async () => {
    db.execute
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ is_highest: true, active_count: 0, deleted: true }]);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'deleted' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.select).not.toHaveBeenCalled();
    // Guard facts and DELETE ride one statement (one snapshot).
    const combined = JSON.stringify(db.execute.mock.calls[1][0]);
    expect(combined).toMatch(/DELETE FROM/);
    expect(combined).toMatch(/is_highest/);
  });

  test('not_last_in_bin when a higher-numbered sibling card exists at the DELETE snapshot', async () => {
    db.execute
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ is_highest: false, active_count: 0, deleted: false }]);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'not_last_in_bin' });
  });

  test('has_active_rows when the highest-numbered card still has active rotation rows', async () => {
    db.execute
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ is_highest: true, active_count: 3, deleted: false }]);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'has_active_rows', activeCount: 3 });
  });

  test('a refusal reports the guard that held even when BOTH refusing facts are present', async () => {
    // Precedence pin: a card that is neither highest nor empty answers
    // not_last_in_bin (matching the pre-consolidation classification order).
    db.execute
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ is_highest: false, active_count: 3, deleted: false }]);

    const result = await deleteRotationCardFromDB(1);

    expect(result).toEqual({ outcome: 'not_last_in_bin' });
  });
});

describe('addToRotation card resolution (BS#2472)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Uncatalogued adds (no `album_id`) keep these tests off the
  // library_identity → LML resolve path, which has its own suite
  // (`library.service.addToRotation.test.ts`). Card resolution reads arrive
  // as raw FOR-UPDATE statements on the transaction's `execute` — the lock
  // must live in the same transaction as the INSERT it protects.

  const UNCATALOGUED = { artist_name: 'Juana Molina', album_title: 'DOGA' };

  test("defaults a card-less add onto the bin's newest card, inside the insert transaction", async () => {
    db.execute.mockResolvedValueOnce([{ id: 7 }]);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: 7 }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'M', ...UNCATALOGUED });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.card_id).toBe(7);
  });

  test('a bin with no cards leaves the row unfiled', async () => {
    db.execute.mockResolvedValueOnce([]);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: null }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'M', ...UNCATALOGUED });

    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.card_id).toBeUndefined();
  });

  test("accepts an explicit card_id whose card lives in the row's bin", async () => {
    db.execute.mockResolvedValueOnce([{ bin: 'M' }]);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: 7 }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'M', card_id: 7, ...UNCATALOGUED });

    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.card_id).toBe(7);
  });

  test('bin agreement is checked against the NORMALIZED request bin', async () => {
    // The controller validates the bin's spelling but forwards it raw, so a
    // lowercase 'm' must still match a card filed in 'M'.
    db.execute.mockResolvedValueOnce([{ bin: 'M' }]);
    const insertChain = createMockQueryChain([{ id: 42, rotation_bin: 'M', card_id: 7 }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'm' as 'M', card_id: 7, ...UNCATALOGUED });

    expect(insertChain.values).toHaveBeenCalled();
  });

  test('throws RotationCardBinMismatchError when the card lives in a different bin', async () => {
    db.execute.mockResolvedValueOnce([{ bin: 'S' }]);

    await expect(addToRotation({ rotation_bin: 'M', card_id: 7, ...UNCATALOGUED })).rejects.toThrow(
      RotationCardBinMismatchError
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  test('404s a card_id that references no card', async () => {
    db.execute.mockResolvedValueOnce([]);

    await expect(addToRotation({ rotation_bin: 'M', card_id: 999, ...UNCATALOGUED })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
