// Regression guard: getEntriesByShow serves the live per-show flowsheet
// (GET /flowsheet?shows_limit=N → flowsheet.controller.ts). play_order is set
// independently by the tubafrenzy webhook and the dj-site live-insert path and
// CAN collide within a show (schema.ts docstring: "the read layer reconciles";
// per-show UNIQUE on play_order is explicitly forbidden). Ordering by
// play_order alone leaves tied rows in arbitrary heap order, so the live
// flowsheet "randomly rearranges" between polls. A deterministic secondary
// sort on flowsheet.id (globally monotonic) fixes the reconciliation without a
// schema change.

import { jest } from '@jest/globals';
import { db, flowsheet } from '@wxyc/database';
import { desc } from 'drizzle-orm';
import { getEntriesByShow } from '../../../apps/backend/services/flowsheet.service';

describe('flowsheet.service', () => {
  describe('getEntriesByShow ordering (duplicate play_order tiebreak)', () => {
    // Chain: select → from → leftJoin(rotation) → leftJoin(library) →
    // leftJoin(album_metadata) → where → orderBy.
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock3 = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock2 = jest.fn().mockReturnValue({ leftJoin: leftJoinMock3 });
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
      leftJoinMock2.mockReturnValue({ leftJoin: leftJoinMock3 });
      leftJoinMock3.mockReset();
      leftJoinMock3.mockReturnValue({ where: whereMock });
      fromMock.mockReset();
      fromMock.mockReturnValue({ leftJoin: leftJoinMock1 });
      (db as unknown as { select: jest.Mock }).select = jest.fn().mockReturnValue({ from: fromMock });
    });

    it('orders by play_order DESC then id DESC as a deterministic tiebreak', async () => {
      await getEntriesByShow(1);

      expect(orderByMock).toHaveBeenCalledTimes(1);
      const orderByArgs = orderByMock.mock.calls[0];
      expect(orderByArgs[0]).toEqual(desc(flowsheet.play_order));
      // Secondary key: without it, rows with equal play_order sort
      // nondeterministically and the live flowsheet reshuffles between polls.
      expect(orderByArgs[1]).toEqual(desc(flowsheet.id));
    });
  });
});
