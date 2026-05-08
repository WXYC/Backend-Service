// Regression guard for #714: post-#693 play_order is per-show, so an id-range fetch must order by flowsheet.id.

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
      expect(orderByArg).toEqual(desc(flowsheet.id));
      expect(orderByArg).not.toEqual(desc(flowsheet.play_order));
    });
  });
});
