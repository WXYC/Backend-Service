import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';
import WxycError from '../../../apps/backend/utils/error';
import { startShow } from '../../../apps/backend/services/flowsheet.service';

describe('startShow', () => {
  it('throws a 404 error before inserting a show when the DJ does not exist', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit.mockResolvedValue([]);
    (db.select as jest.Mock).mockReturnValue(selectChain);

    await expect(startShow('nonexistent-dj-id')).rejects.toThrow('not found');
    expect(db.insert).not.toHaveBeenCalled();
  });
});
