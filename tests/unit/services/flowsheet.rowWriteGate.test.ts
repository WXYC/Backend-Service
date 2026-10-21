/**
 * Unit table for the row-scoped write gate (BS#3438), `assertCallerMayWriteRow` in
 * `apps/backend/services/flowsheet.service.ts`. The gate is private, so it is driven through `removeTrack` with a
 * non-null caller (a null caller is the AUTH_BYPASS short-circuit and skips the gate). The transaction's reads are
 * answered in the order the service issues them: the row's show_id, the show's end_time, the show's newest row (only
 * while end_time is NULL), the show's active show_djs rows, then the DJs' user rows (both only while the show is on
 * the air). The decision itself is tabled in tests/unit/utils/may-edit-show.test.ts (BS#3455).
 */
import { jest } from '@jest/globals';
import { db } from '@wxyc/database';
import WxycError from '../../../apps/backend/utils/error';

const CALLER = { id: 'dj-caller', canManageFlowsheet: false };
const MANAGER = { id: 'md-caller', canManageFlowsheet: true };
const NOT_SHOW_END = [{ entry_type: 'track' }];

const makeTrx = (reads: unknown[][]) => {
  const queue = [...reads];
  const thenable = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'for', 'limit', 'orderBy']) {
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
  const rejects: Array<[string, unknown[][], number, string | undefined]> = [
    ['a NULL show_id', [[{ show_id: null }]], 400, undefined],
    ['a show row that no longer exists', [[{ show_id: 5 }], []], 400, undefined],
    ['an ended show', [[{ show_id: 5 }], [{ end_time: new Date() }]], 403, 'closed_show'],
    [
      'a show with NULL end_time whose newest row is show_end',
      [[{ show_id: 5 }], [{ end_time: null }], [{ entry_type: 'show_end' }]],
      403,
      'closed_show',
    ],
    ['an open show with no active members', [[{ show_id: 5 }], [{ end_time: null }], NOT_SHOW_END, []], 400, undefined],
    [
      'an open show the caller is not a member of',
      [[{ show_id: 5 }], [{ end_time: null }], NOT_SHOW_END, [{ dj_id: 'other' }], [{ id: 'other' }]],
      400,
      undefined,
    ],
  ];

  test.each(rejects)('rejects a row on %s and does not delete', async (_name, reads, statusCode, code) => {
    const trx = makeTrx(reads);
    (db as any).transaction = jest.fn().mockImplementation(async (cb: (t: typeof trx) => Promise<unknown>) => cb(trx));
    const { removeTrack } = await import('../../../apps/backend/services/flowsheet.service');

    const attempt = removeTrack(1, CALLER);
    await expect(attempt).rejects.toThrow(WxycError);
    await expect(attempt).rejects.toMatchObject({ statusCode, code });
    expect(trx.delete).not.toHaveBeenCalled();
  });

  test.each([
    [
      'an open show the caller is an active member of',
      CALLER,
      [[{ show_id: 5 }], [{ end_time: null }], NOT_SHOW_END, [{ dj_id: CALLER.id }], [{ id: CALLER.id }]],
    ],
    [
      'an ended show, for a caller who can manage the flowsheet',
      MANAGER,
      [[{ show_id: 5 }], [{ end_time: new Date() }]],
    ],
    [
      'a dropped-show_end show, for a caller who can manage the flowsheet',
      MANAGER,
      [[{ show_id: 5 }], [{ end_time: null }], [{ entry_type: 'show_end' }]],
    ],
  ])('accepts a row on %s', async (_name, caller, reads) => {
    const trx = makeTrx(reads);
    (db as any).transaction = jest.fn().mockImplementation(async (cb: (t: typeof trx) => Promise<unknown>) => cb(trx));
    const { removeTrack } = await import('../../../apps/backend/services/flowsheet.service');

    await expect(removeTrack(1, caller)).resolves.toEqual({ id: 1 });
    expect(trx.delete).toHaveBeenCalledTimes(1);
  });
});
