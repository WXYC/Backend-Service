/**
 * `transitionIntakeItem` and `answeredRequest` (BS#3388): a pass emails the music directors only when it answers a request, and the
 * state it decides that on is read under the item's row lock, in the pass's own transaction, before the UPDATE. Against a stand-in
 * transaction with the real schema, as in `intake.finalize.service.test.ts`; the SQL itself is pinned in `intake.service.sql.test.ts`.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

import { db } from '@wxyc/database';
import { transitionIntakeItem, type IntakeAction } from '../../../apps/backend/services/intake.service';
import { createLockLog } from '../../utils/lock-log-builder';

describe('transitionIntakeItem — answeredRequest (BS#3388)', () => {
  const { builder, log } = createLockLog();
  const dj = { id: 'dj-1', manage: false };
  const ITEM = { id: 7, effective_state: 'pool' };

  const run = async (action: IntakeAction, locked: unknown[], updated: unknown[]) => {
    log.length = 0;
    const tx = {
      select: jest.fn(() => builder(locked)),
      update: jest.fn(() => builder(updated)),
      insert: jest.fn(() => builder([])),
    };
    const transaction = jest
      .spyOn(db, 'transaction')
      .mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    const update = jest.spyOn(db, 'update').mockReturnValue(builder(updated) as never);
    jest.spyOn(db, 'select').mockReturnValue(builder([ITEM]) as never);
    return { result: await transitionIntakeItem(action, 7, dj, 'dj-2'), tx, transaction, update };
  };

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['requested', true],
    ['checked_out', false],
  ] as const)('a pass of a %s item answers a request: %s', async (state, answeredRequest) => {
    const { result } = await run('pass', [{ state }], [{ id: 7 }]);
    expect(result).toEqual({ outcome: 'updated', item: ITEM, answeredRequest });
  });

  it('reads the state under the item’s row lock, before the UPDATE, in the pass’s transaction', async () => {
    const { tx } = await run('pass', [{ state: 'requested' }], [{ id: 7 }]);
    expect(log).toEqual(['intake_items for update id 7']);
    expect(tx.select.mock.invocationCallOrder[0]).toBeLessThan(tx.update.mock.invocationCallOrder[0]);
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  it('writes nothing and answers the refusal when the UPDATE matched no row', async () => {
    const { result, tx } = await run('pass', [{ state: 'requested' }], []);
    expect(result).toEqual({ outcome: 'state_changed' });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('answers not_found for a missing item, with nothing locked', async () => {
    jest.spyOn(db, 'select').mockReturnValue(builder([]) as never);
    const tx = { select: jest.fn(() => builder([])), update: jest.fn(() => builder([])), insert: jest.fn() };
    jest.spyOn(db, 'transaction').mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    expect(await transitionIntakeItem('pass', 8, dj)).toEqual({ outcome: 'not_found' });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it.each(['checkout', 'release', 'request', 'cancel_request', 'accept'] as const)(
    '%s takes no transaction and no lock, and answers no request',
    async (action) => {
      const { result, transaction, update } = await run(action, [], [{ id: 7 }]);
      expect(result).toEqual({ outcome: 'updated', item: ITEM, answeredRequest: false });
      expect(transaction).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
      expect(log).toEqual([]);
    }
  );
});
