/**
 * Unit table for the row-scoped write gate (BS#3438), `assertCallerMayWriteRow` in
 * `apps/backend/services/flowsheet.service.ts`. The gate is private, so it is driven through `removeTrack` with a
 * non-null caller (a null caller is the AUTH_BYPASS short-circuit and skips the gate). The transaction's reads are
 * answered in the order the service issues them: the row's show_id, the show's end_time, the show's active show_djs
 * rows, then the DJs' user rows.
 */
import { jest } from '@jest/globals';
import { db } from '@wxyc/database';
import WxycError from '../../../apps/backend/utils/error';

const CALLER = 'dj-caller';

const makeTrx = (reads: unknown[][]) => {
  const queue = [...reads];
  const thenable = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'for', 'limit']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown) => void) => resolve(rows);
    return chain;
  };
  return {
    select: jest.fn().mockImplementation(() => thenable(queue.shift() ?? [])),
    delete: jest.fn().mockImplementation(() => ({
      where: jest
        .fn()
        .mockReturnValue({ returning: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([{ id: 1 }]) }),
    })),
  };
};

describe('assertCallerMayWriteRow via removeTrack (BS#3438)', () => {
  const rejects: Array<[string, unknown[][]]> = [
    ['a NULL show_id', [[{ show_id: null }]]],
    ['a show row that no longer exists', [[{ show_id: 5 }], []]],
    ['an ended show', [[{ show_id: 5 }], [{ end_time: new Date() }]]],
    ['an open show with no active members', [[{ show_id: 5 }], [{ end_time: null }], []]],
    [
      'an open show the caller is not a member of',
      [[{ show_id: 5 }], [{ end_time: null }], [{ dj_id: 'other' }], [{ id: 'other' }]],
    ],
  ];

  test.each(rejects)('rejects a row on %s with a 400 and does not delete', async (_name, reads) => {
    const trx = makeTrx(reads);
    (db as any).transaction = jest.fn().mockImplementation(async (cb: (t: typeof trx) => Promise<unknown>) => cb(trx));
    const { removeTrack } = await import('../../../apps/backend/services/flowsheet.service');

    const attempt = removeTrack(1, CALLER);
    await expect(attempt).rejects.toThrow(WxycError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    expect(trx.delete).not.toHaveBeenCalled();
  });

  test('accepts a row on an open show the caller is an active member of', async () => {
    const trx = makeTrx([[{ show_id: 5 }], [{ end_time: null }], [{ dj_id: CALLER }], [{ id: CALLER }]]);
    (db as any).transaction = jest.fn().mockImplementation(async (cb: (t: typeof trx) => Promise<unknown>) => cb(trx));
    const { removeTrack } = await import('../../../apps/backend/services/flowsheet.service');

    await expect(removeTrack(1, CALLER)).resolves.toEqual({ id: 1 });
    expect(trx.delete).toHaveBeenCalledTimes(1);
  });
});
