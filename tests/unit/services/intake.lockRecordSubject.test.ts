/**
 * `lockRecordSubject` (BS#2968): the release-then-item lock order `DELETE /library/{id}` (BS#2928) expects, against a
 * stand-in transaction. Real schema, as in `intake.file.service.test.ts`. Each lock is logged with the id its `where()` bound,
 * so the table pins WHICH row is locked (a filed item's lock targets the item's release, not its own id).
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const nyTime = jest.requireActual('../../../shared/database/src/ny-time');
  return { ...realSchema, ...nyTime, db: drizzle({}) };
});

import { lockRecordSubject } from '../../../apps/backend/services/intake.service';
import { createLockLog } from '../../utils/lock-log-builder';

describe('lockRecordSubject (BS#2968)', () => {
  const { builder, log } = createLockLog();
  const unfiled = { album_id: null, state: 'pool' };
  const filed = { album_id: 9, state: 'filed' };

  it.each([
    ['release subject', { album_id: 9 }, 'share', [[{ id: 9 }]], ['library for key share id 9'], { album_id: 9 }],
    ['missing release', { album_id: 9 }, 'share', [[]], ['library for key share id 9'], undefined],
    ['missing item', { intake_item_id: 4 }, 'share', [[]], [], undefined],
    [
      'unfiled item, update',
      { intake_item_id: 4 },
      'update',
      [[unfiled], [unfiled]],
      ['intake_items for update id 4'],
      { intake_item_id: 4, album_id: null },
    ],
    [
      'filed item, share: library row before the item',
      { intake_item_id: 4 },
      'share',
      [[filed], [{ id: 9 }], [filed]],
      ['library for key share id 9', 'intake_items for share id 4'],
      { intake_item_id: 4, album_id: 9 },
    ],
    [
      'filed item whose release was deleted',
      { intake_item_id: 4 },
      'share',
      [[filed], []],
      ['library for key share id 9'],
      undefined,
    ],
    [
      'item filed between the read and the lock',
      { intake_item_id: 4 },
      'update',
      [[unfiled], [filed]],
      ['intake_items for update id 4'],
      undefined,
    ],
  ] as const)('%s', async (_name, subject, mode, selects, locks, expected) => {
    log.length = 0;
    const queue = selects.map((rows) => [...rows]);
    const tx = { select: jest.fn(() => builder(queue.shift() ?? [])) };
    expect(await lockRecordSubject(tx as never, subject, mode)).toEqual(expected);
    expect(log).toEqual(locks);
  });
});
