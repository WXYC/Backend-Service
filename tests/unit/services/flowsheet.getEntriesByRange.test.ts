/**
 * Regression guard for `getEntriesByRange` in
 * `apps/backend/services/flowsheet.service.ts`.
 *
 * Background (#714):
 *
 * After #693 (`f71b3ef`) made `play_order` per-show, ordering the
 * result of an id-range fetch by `desc(flowsheet.play_order)` became
 * meaningless: the range filter is on `flowsheet.id`, which can span
 * multiple shows, so two rows in different shows are compared by
 * play_orders that are no longer globally comparable. The fix matches
 * the sibling `getEntriesByPage` function and orders by the globally
 * monotonic `flowsheet.id` instead.
 *
 * The test mocks the drizzle query chain and asserts the argument
 * passed to `.orderBy(...)` resolves to `desc(flowsheet.id)`.
 */

import { jest } from '@jest/globals';
import { db, flowsheet } from '@wxyc/database';
import { desc } from 'drizzle-orm';
import { getEntriesByRange } from '../../../apps/backend/services/flowsheet.service';

describe('flowsheet.service', () => {
  describe('getEntriesByRange ordering (#714)', () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock2 = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock1 = jest.fn().mockReturnValue({ leftJoin: leftJoinMock2 });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock1 });

    beforeEach(() => {
      orderByMock.mockReset();
      orderByMock.mockResolvedValue([]);
      whereMock.mockReset();
      whereMock.mockReturnValue({ orderBy: orderByMock });
      leftJoinMock1.mockReset();
      leftJoinMock1.mockReturnValue({ leftJoin: leftJoinMock2 });
      leftJoinMock2.mockReset();
      leftJoinMock2.mockReturnValue({ where: whereMock });
      fromMock.mockReset();
      fromMock.mockReturnValue({ leftJoin: leftJoinMock1 });
      (db as unknown as { select: jest.Mock }).select = jest.fn().mockReturnValue({ from: fromMock });
    });

    it('passes desc(flowsheet.id) to orderBy, not desc(flowsheet.play_order)', async () => {
      await getEntriesByRange(1, 10);

      expect(orderByMock).toHaveBeenCalledTimes(1);
      const orderByArg = orderByMock.mock.calls[0][0];

      // Under the global drizzle-orm mock (`tests/__mocks__/drizzle-orm.ts`),
      // `desc(col)` returns `{ desc: col }`. With `flowsheet.id === 'id'`
      // and `flowsheet.play_order === 'play_order'` from `database.mock.ts`,
      // the two are easy to tell apart by deep equality.
      expect(orderByArg).toEqual(desc(flowsheet.id));
      expect(orderByArg).not.toEqual(desc(flowsheet.play_order));
    });
  });
});
