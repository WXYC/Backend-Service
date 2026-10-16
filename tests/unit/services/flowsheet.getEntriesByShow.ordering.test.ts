// Regression guard: getEntriesByShow serves the live per-show flowsheet
// (GET /flowsheet?shows_limit=N → flowsheet.controller.ts). play_order is set
// independently by the tubafrenzy webhook and the dj-site live-insert path and
// CAN collide within a show (schema.ts docstring: "the read layer reconciles";
// per-show UNIQUE on play_order is explicitly forbidden). Ordering by
// play_order alone leaves tied rows in arbitrary heap order, so the live
// flowsheet "randomly rearranges" between polls. A deterministic secondary
// sort on flowsheet.id (globally monotonic) fixes the reconciliation without a
// schema change.

import { flowsheet } from '@wxyc/database';
import { desc } from 'drizzle-orm';
import { getEntriesByShow } from '../../../apps/backend/services/flowsheet.service';
import {
  installRecursiveSelectMock,
  type RecursiveSelectMockCapture as MockCapture,
} from '../../utils/recursive-select-mock';

describe('flowsheet.service', () => {
  describe('getEntriesByShow ordering (duplicate play_order tiebreak)', () => {
    let capture: MockCapture;

    beforeEach(() => {
      capture = installRecursiveSelectMock();
    });

    it('orders by play_order DESC then id DESC as a deterministic tiebreak', async () => {
      await getEntriesByShow(1);

      expect(capture.orderByCalls).toHaveLength(1);
      const orderByArgs = capture.orderByCalls[0];
      expect(orderByArgs[0]).toEqual(desc(flowsheet.play_order));
      // Secondary key: without it, rows with equal play_order sort
      // nondeterministically and the live flowsheet reshuffles between polls.
      expect(orderByArgs[1]).toEqual(desc(flowsheet.id));
    });
  });
});
