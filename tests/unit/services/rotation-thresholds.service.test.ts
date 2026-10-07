import { jest } from '@jest/globals';
import { db, createMockQueryChain, rotation_thresholds } from '../../mocks/database.mock';

import {
  getRotationThresholds,
  updateRotationThresholds,
} from '../../../apps/backend/services/rotation-thresholds.service';

const row = {
  id: true,
  window_days_h: 60,
  window_days_m: 45,
  window_days_l: 60,
  window_days_s: 90,
  card_stale_days: 30,
};
const wire = { window_days: { H: 60, M: 45, L: 60, S: 90 }, card_stale_days: 30 };

describe('rotation thresholds service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getRotationThresholds reads the singleton row and maps it to the wire shape', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([row]);
    db.select.mockReturnValue(selectChain);

    await expect(getRotationThresholds()).resolves.toEqual(wire);
    expect(selectChain.from).toHaveBeenCalledWith(rotation_thresholds);
  });

  test('getRotationThresholds throws when the seeded row is missing', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    await expect(getRotationThresholds()).rejects.toThrow(/row is missing/);
  });

  test('updateRotationThresholds throws the same descriptive error when the seeded row is missing', async () => {
    db.update.mockReturnValue(createMockQueryChain([]));

    await expect(updateRotationThresholds({ card_stale_days: 14 })).rejects.toThrow(/row is missing/);
  });

  test('updateRotationThresholds sets only the supplied columns and returns the whole record', async () => {
    const updateChain = createMockQueryChain([{ ...row, window_days_h: 30, card_stale_days: 14 }]);
    db.update.mockReturnValue(updateChain);

    const result = await updateRotationThresholds({ window_days: { H: 30 }, card_stale_days: 14 });

    expect(db.update).toHaveBeenCalledWith(rotation_thresholds);
    expect(updateChain.set).toHaveBeenCalledWith({ window_days_h: 30, card_stale_days: 14 });
    expect(result).toEqual({ window_days: { ...wire.window_days, H: 30 }, card_stale_days: 14 });
  });

  test.each([[{}], [{ window_days: {} }]])(
    'an empty patch %j issues no UPDATE and returns the current record',
    async (patch) => {
      const selectChain = createMockQueryChain();
      selectChain.limit = jest.fn().mockResolvedValue([row]);
      db.select.mockReturnValue(selectChain);

      await expect(updateRotationThresholds(patch)).resolves.toEqual(wire);
      expect(db.update).not.toHaveBeenCalled();
    }
  );
});
