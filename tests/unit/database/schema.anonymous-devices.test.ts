import { getTableConfig } from 'drizzle-orm/pg-core';
import { anonymous_devices } from '../../../shared/database/src/schema';

describe('anonymous_devices schema', () => {
  it('should have exactly one uniqueness constraint on device_id', () => {
    const config = getTableConfig(anonymous_devices);
    const col = anonymous_devices.deviceId;

    let uniqueCount = 0;

    // .unique() on the column sets isUnique at the column level
    if (col.isUnique) uniqueCount++;

    // uniqueIndex() in the table's third argument appears in config.indexes
    const uniqueIndexesOnDeviceId = config.indexes.filter(
      (idx) =>
        idx.config.unique &&
        idx.config.columns.some(
          (c) => 'name' in c && c.name === 'device_id'
        )
    );
    uniqueCount += uniqueIndexesOnDeviceId.length;

    expect(uniqueCount).toBe(1);
  });
});
