import { shift_covers } from '../../../shared/database/src/schema';

describe('shift_covers schema', () => {
  it('schedule_id should not be a serial/auto-increment column', () => {
    const column = shift_covers.schedule_id;
    expect(column.columnType).not.toBe('PgSerial');
  });
});
