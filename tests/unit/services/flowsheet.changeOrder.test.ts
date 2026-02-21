import { jest } from '@jest/globals';
import { db } from '@wxyc/database';
import { createMockQueryChain } from '../../mocks/database.mock';
import WxycError from '../../../apps/backend/utils/error';

describe('flowsheet.service', () => {
  describe('changeOrder', () => {
    it('throws WxycError with 404 when entry does not exist', async () => {
      const emptyChain = createMockQueryChain([]);
      // Make the chain thenable so `await trx.select().from().where().limit()` resolves
      (emptyChain as any).then = (resolve: (v: unknown) => void) => resolve([]);

      const mockTrx = {
        select: jest.fn().mockReturnValue(emptyChain),
        update: jest.fn().mockReturnValue(emptyChain),
      };

      (db as any).transaction = jest.fn().mockImplementation(async (cb: Function) => {
        return cb(mockTrx);
      });

      const { changeOrder } = await import('../../../apps/backend/services/flowsheet.service');

      await expect(changeOrder(999999, 1)).rejects.toThrow(WxycError);
      await expect(changeOrder(999999, 1)).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });
});
