/**
 * `fileIntakeItem` / `mayFileItem` (BS#2803): the lock order, the single transaction's writes and the outcomes, against
 * a stand-in transaction (the SQL against real rows is `tests/integration/intake-file.spec.js`). Real schema, as in
 * `intake.service.sql.test.ts`; the filing seam is mocked, since its own tests live with it.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

const mockFileLibraryRelease = jest.fn();
const mockMapLibraryFilingError = jest.fn((error: unknown) => {
  throw error;
});
jest.mock('../../../apps/backend/services/library-filing.service', () => ({
  fileLibraryRelease: mockFileLibraryRelease,
  mapLibraryFilingError: mockMapLibraryFilingError,
}));

import { getTableName } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { fileIntakeItem, mayFileItem } from '../../../apps/backend/services/intake.service';
import { createLockLog } from '../../utils/lock-log-builder';

describe('mayFileItem (BS#2803)', () => {
  it.each([
    [7, true],
    [null, false],
  ])('accepted_review_id %p is %p', (accepted_review_id, expected) => {
    expect(mayFileItem({ accepted_review_id })).toBe(expected);
  });
});

describe('fileIntakeItem (BS#2803)', () => {
  const { builder, log, setsByTable: sets } = createLockLog();
  const reviewed = { state: 'reviewed', accepted_review_id: 3 };
  const newRelease = { kind: 'new_release', input: { release: { album_title: 'DOGA' } } } as never;
  const existing = { kind: 'existing_release', album_id: 9 } as const;

  const run = async (arm: Parameters<typeof fileIntakeItem>[1], selects: unknown[][]) => {
    log.length = 0;
    for (const key of Object.keys(sets)) delete sets[key];
    const tx = {
      select: jest.fn(() => builder(selects.shift() ?? [])),
      update: jest.fn((table: never) => builder([], undefined, getTableName(table))),
      delete: jest.fn(() => builder([])),
    };
    jest.spyOn(db, 'transaction').mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    jest.spyOn(db, 'select').mockReturnValue(builder([{ id: 7 }]) as never);
    return { result: await fileIntakeItem(7, arm, 'md-1'), tx };
  };

  beforeEach(() => {
    mockFileLibraryRelease.mockReset().mockResolvedValue({ release: { id: 42 }, rotation: { id: 5 } });
    mockMapLibraryFilingError.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('existing release: the library row FOR KEY SHARE, then the item FOR UPDATE, and no library insert', async () => {
    const { result } = await run(existing, [[{ id: 9 }], [reviewed]]);
    expect(result.outcome).toBe('filed');
    expect(log).toEqual(['library for key share id 9', 'intake_items for update id 7']);
    expect(mockFileLibraryRelease).not.toHaveBeenCalled();
    expect(sets.intake_items).toMatchObject({ album_id: 9, rotation_id: null });
  });

  it('existing release: an album the locked read does not find is unknown_album and takes no item lock', async () => {
    const { result, tx } = await run(existing, [[]]);
    expect(result).toEqual({ outcome: 'unknown_album' });
    expect(log).toEqual(['library for key share id 9']);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('new release: the item lock first, then fileLibraryRelease on the same transaction, and the item gets its ids', async () => {
    const { result, tx } = await run(newRelease, [[reviewed]]);
    expect(result.outcome).toBe('filed');
    expect(log).toEqual(['intake_items for update id 7']);
    expect(mockFileLibraryRelease).toHaveBeenCalledWith(
      (newRelease as { input: unknown }).input,
      { kind: 'intake', intakeItemId: 7 },
      tx
    );
    expect(sets.intake_items).toMatchObject({ state: 'filed', album_id: 42, rotation_id: 5, filed_by: 'md-1' });
  });

  it('clears the holder and the request, keeps the accept columns, and stamps every review, print and FCC note of the item', async () => {
    const { tx } = await run(existing, [[{ id: 9 }], [reviewed]]);
    expect(sets.intake_items).toMatchObject({
      checked_out_by: null,
      checked_out_at: null,
      requested_dj_id: null,
      requested_at: null,
    });
    expect(sets.intake_items).not.toHaveProperty('accepted_review_id');
    expect(sets.intake_items).not.toHaveProperty('accepted_by');
    expect(sets.intake_items).not.toHaveProperty('accepted_at');
    expect(sets.reviews).toEqual({ album_id: 9 });
    expect(sets.review_prints).toEqual({ album_id: 9 });
    expect(sets.fcc_notes).toEqual({ album_id: 9 });
    expect(tx.delete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no such item', [], 'not_found'],
    ['a filed item', [{ state: 'filed', accepted_review_id: 3 }], 'state_changed'],
    ['a finalized item', [{ state: 'finalized', accepted_review_id: 3 }], 'state_changed'],
    ['no accepted review', [{ state: 'checked_out', accepted_review_id: null }], 'not_reviewed'],
  ])('%s is %s and writes nothing', async (_name, itemRows, outcome) => {
    const { result, tx } = await run(newRelease, [itemRows]);
    expect(result).toEqual({ outcome });
    expect(mockFileLibraryRelease).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it('answers the mapped 409 body for a filing failure the seam recognises, and rethrows anything else', async () => {
    mockFileLibraryRelease.mockRejectedValue(new Error('rotation mismatch'));
    mockMapLibraryFilingError.mockReturnValueOnce({ message: 'm', reason: 'rotation_card_bin_mismatch' });
    expect((await run(newRelease, [[reviewed]])).result).toEqual({
      outcome: 'filing_conflict',
      body: { message: 'm', reason: 'rotation_card_bin_mismatch' },
    });
    mockFileLibraryRelease.mockRejectedValue(new Error('boom'));
    await expect(run(newRelease, [[reviewed]])).rejects.toThrow('boom');
  });
});
