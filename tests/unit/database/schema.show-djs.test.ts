import { getTableConfig } from 'drizzle-orm/pg-core';
import { show_djs } from '../../../shared/database/src/schema';

describe('show_djs schema', () => {
  it('has a unique index on (show_id, dj_id)', () => {
    const config = getTableConfig(show_djs);
    const uniqueIndexes = config.indexes.filter((idx) => idx.config.unique);

    const showDjIndex = uniqueIndexes.find((idx) =>
      idx.config.columns.length === 2 &&
      idx.config.columns.some((col) => 'name' in col && col.name === 'show_id') &&
      idx.config.columns.some((col) => 'name' in col && col.name === 'dj_id')
    );

    expect(showDjIndex).toBeDefined();
  });
});
