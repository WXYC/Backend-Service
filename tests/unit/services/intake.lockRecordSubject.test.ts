/**
 * `lockRecordSubject` (BS#2968): the release-then-item lock order `DELETE /library/{id}` (BS#2928) expects, against a
 * stand-in transaction. Real schema, as in `intake.file.service.test.ts`.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const nyTime = jest.requireActual('../../../shared/database/src/ny-time');
  return { ...realSchema, ...nyTime, db: drizzle({}) };
});

import { getTableName } from 'drizzle-orm';
import { lockRecordSubject } from '../../../apps/backend/services/intake.service';

describe('lockRecordSubject (BS#2968)', () => {
  const log: string[] = [];
  const builder = (rows: unknown[]): unknown => {
    let table = '';
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(rows);
        return (...args: unknown[]) => {
          if (prop === 'from') table = getTableName(args[0] as Parameters<typeof getTableName>[0]);
          if (prop === 'for') log.push(`${table} for ${args[0] as string}`);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const unfiled = { album_id: null, state: 'pool' };
  const filed = { album_id: 9, state: 'filed' };

  it.each([
    ['release subject', { album_id: 9 }, 'share', [[{ id: 9 }]], ['library for key share'], { album_id: 9 }],
    ['missing release', { album_id: 9 }, 'share', [[]], ['library for key share'], undefined],
    ['missing item', { intake_item_id: 4 }, 'share', [[]], [], undefined],
    [
      'unfiled item, update',
      { intake_item_id: 4 },
      'update',
      [[unfiled], [unfiled]],
      ['intake_items for update'],
      { intake_item_id: 4, album_id: null },
    ],
    [
      'filed item, share: library row before the item',
      { intake_item_id: 4 },
      'share',
      [[filed], [{ id: 9 }], [filed]],
      ['library for key share', 'intake_items for share'],
      { intake_item_id: 4, album_id: 9 },
    ],
    [
      'filed item whose release was deleted',
      { intake_item_id: 4 },
      'share',
      [[filed], []],
      ['library for key share'],
      undefined,
    ],
    [
      'item filed between the read and the lock',
      { intake_item_id: 4 },
      'update',
      [[unfiled], [filed]],
      ['intake_items for update'],
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
