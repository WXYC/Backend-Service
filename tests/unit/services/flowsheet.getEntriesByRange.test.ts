// Regression guard for #714: post-#693 play_order is per-show, so an id-range fetch must order by flowsheet.id.

import { flowsheet } from '@wxyc/database';
import { desc } from 'drizzle-orm';
import { getEntriesByRange } from '../../../apps/backend/services/flowsheet.service';
import {
  installRecursiveSelectMock,
  type RecursiveSelectMockCapture as MockCapture,
} from '../../utils/recursive-select-mock';

describe('flowsheet.service', () => {
  describe('getEntriesByRange ordering (#714)', () => {
    let capture: MockCapture;

    beforeEach(() => {
      capture = installRecursiveSelectMock();
    });

    it('passes desc(flowsheet.id) to orderBy, not desc(flowsheet.play_order)', async () => {
      await getEntriesByRange(1, 10);

      expect(capture.orderByCalls).toHaveLength(1);
      const orderByArg = capture.orderByCalls[0][0];
      expect(orderByArg).toEqual(desc(flowsheet.id));
      expect(orderByArg).not.toEqual(desc(flowsheet.play_order));
    });
  });
});
