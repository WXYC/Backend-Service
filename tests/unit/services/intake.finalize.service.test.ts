/**
 * `finalizeIntakeItem` (BS#2804): the state check, the `in_rotation` refusal found by `album_id` through
 * `rotationActiveSql()`, and the one write, against a stand-in transaction. Real schema, as in `intake.file.service.test.ts`.
 */

jest.unmock('drizzle-orm');

const mockRotationActiveSql = jest.fn();
jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const nyTime = jest.requireActual('../../../shared/database/src/ny-time');
  mockRotationActiveSql.mockImplementation(realSchema.rotationActiveSql);
  return { ...realSchema, ...nyTime, rotationActiveSql: mockRotationActiveSql, db: drizzle({}) };
});

import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@wxyc/database';
import { finalizeIntakeItem } from '../../../apps/backend/services/intake.service';
import { createLockLog } from '../../utils/lock-log-builder';

describe('finalizeIntakeItem (BS#2804)', () => {
  const { builder, log, setsByTable: sets, wheres } = createLockLog();
  const filed = { state: 'filed', album_id: 9 };
  const ITEM = { id: 7, state: 'finalized' };

  const run = async (selects: unknown[][]) => {
    log.length = 0;
    wheres.length = 0;
    for (const key of Object.keys(sets)) delete sets[key];
    const tx = {
      select: jest.fn(() => builder(selects.shift() ?? [])),
      update: jest.fn((table: never) => builder([], undefined, getTableName(table))),
    };
    jest.spyOn(db, 'transaction').mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    jest.spyOn(db, 'select').mockReturnValue(builder([ITEM]) as never);
    return { result: await finalizeIntakeItem(7, 'lib-1'), tx };
  };

  beforeEach(() => mockRotationActiveSql.mockClear());
  afterEach(() => jest.restoreAllMocks());

  it('finalizes a filed item whose release has no active rotation row, stamping the caller', async () => {
    const { result, tx } = await run([[filed], []]);
    expect(result).toEqual({ outcome: 'finalized', item: ITEM });
    expect(log).toEqual(['intake_items for update id 7']);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(sets.intake_items).toMatchObject({ state: 'finalized', finalized_by: 'lib-1' });
    expect(sets.intake_items).toHaveProperty('finalized_at');
  });

  it('asks the one active-rotation predicate, by the release rather than the item’s rotation_id', async () => {
    await run([[filed], []]);
    expect(mockRotationActiveSql).toHaveBeenCalledTimes(1);
    // The second select is the rotation lookup. Render its WHERE: the release column, bound to the item's album id.
    const { sql: text, params } = new PgDialect().sqlToQuery(wheres[1]);
    expect(text).toContain('"rotation"."album_id" = $1');
    expect(text).not.toContain('"rotation"."id"');
    expect(params).toEqual([filed.album_id]);
  });

  it.each([
    [
      'one row with a kill date ahead',
      [{ kill_date: '2026-11-05' }],
      'The release is still in rotation until 2026-11-05',
    ],
    ['the latest of several', [{ kill_date: '2026-11-05' }, { kill_date: '2026-12-01' }], 'until 2026-12-01'],
    ['a row with no kill date', [{ kill_date: null }], 'no kill date is set'],
    [
      'a row with no kill date among dated ones',
      [{ kill_date: '2026-11-05' }, { kill_date: null }],
      'no kill date is set',
    ],
  ])('refuses in_rotation for %s, writing nothing', async (_name, active, message) => {
    const { result, tx } = await run([[filed], active]);
    expect(result).toEqual({ outcome: 'in_rotation', message: expect.stringContaining(message) });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each([['pool'], ['reviewed'], ['finalized']])(
    'is state_changed for a %s item, with no rotation read',
    async (state) => {
      const { result, tx } = await run([[{ state, album_id: null }]]);
      expect(result).toEqual({ outcome: 'state_changed' });
      expect(tx.select).toHaveBeenCalledTimes(1);
      expect(tx.update).not.toHaveBeenCalled();
    }
  );

  it('is not_found for a missing item', async () => {
    expect((await run([[]])).result).toEqual({ outcome: 'not_found' });
  });
});
