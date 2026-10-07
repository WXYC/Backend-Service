/**
 * `/fcc-notes` create and list (BS#2862): the lock order, the retry, what is written and the one-statement list, against a
 * stand-in transaction. Real schema, as in `intake.file.service.test.ts`; the SQL against real rows is
 * `tests/integration/fcc-notes.spec.js`.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const nyTime = jest.requireActual('../../../shared/database/src/ny-time');
  return { ...realSchema, ...nyTime, db: drizzle({}) };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@wxyc/database';
import {
  createFccNote,
  fccNoteSelection,
  listFccNotes,
  selectFccNotes,
} from '../../../apps/backend/services/fcc-notes.service';
import { createLockLog } from '../../utils/lock-log-builder';

describe('createFccNote (BS#2862)', () => {
  const { builder, log } = createLockLog();
  const actor = { id: 'dj-1', manage: false };
  const fields = { track: 'la paradoja', note: 'A placeholder note.' };
  const unfiled = { album_id: null, state: 'pool' };
  const filed = { album_id: 9, state: 'filed' };
  const account = { name: 'Test Reviewer' };
  const noteRow = { id: 11, artist_name: 'Juana Molina', album_title: 'DOGA' };
  let inserted: Record<string, unknown>[];
  let transaction: jest.SpyInstance;

  const run = async (subject: Parameters<typeof createFccNote>[0], selects: unknown[][]) => {
    log.length = 0;
    inserted = [];
    const queue = selects.map((rows) => [...rows]);
    const tx = {
      select: jest.fn(() => builder(queue.shift() ?? [])),
      insert: jest.fn(() => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return builder([{ id: 11 }], 'insert fcc_notes');
        },
      })),
    };
    transaction = jest
      .spyOn(db, 'transaction')
      .mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    return createFccNote(subject, fields, actor);
  };

  afterEach(() => jest.restoreAllMocks());

  it('an unfiled item: locked FOR SHARE, no hold needed, stamped with no release, and the caller is the reporter', async () => {
    const result = await run({ intake_item_id: 4 }, [[unfiled], [unfiled], [account], [noteRow]]);
    expect(log).toEqual(['intake_items for share id 4', 'insert fcc_notes']);
    expect(inserted).toEqual([
      {
        ...fields,
        intake_item_id: 4,
        album_id: null,
        status: 'reported',
        reported_by: 'Test Reviewer',
        reported_by_user_id: 'dj-1',
      },
    ]);
    expect(result).toMatchObject({ outcome: 'created', note: noteRow });
  });

  it('a filed item: the library row FOR KEY SHARE, then the item FOR SHARE, then the insert, stamped with the release', async () => {
    await run({ intake_item_id: 4 }, [[filed], [{ id: 9 }], [filed], [account], [noteRow]]);
    expect(log).toEqual(['library for key share id 9', 'intake_items for share id 4', 'insert fcc_notes']);
    expect(inserted).toEqual([expect.objectContaining({ intake_item_id: 4, album_id: 9 })]);
  });

  it('a release: the library row FOR KEY SHARE, and the note carries no item', async () => {
    await run({ album_id: 9 }, [[{ id: 9 }], [account], [noteRow]]);
    expect(log).toEqual(['library for key share id 9', 'insert fcc_notes']);
    expect(inserted).toEqual([expect.objectContaining({ album_id: 9, intake_item_id: undefined })]);
  });

  it('hands back what the notice needs: the note, the record, and the reporter', async () => {
    const result = await run({ album_id: 9 }, [[{ id: 9 }], [account], [noteRow]]);
    expect(result).toMatchObject({
      notice: { note: noteRow, artist: 'Juana Molina', album: 'DOGA', reporterUserId: 'dj-1' },
    });
  });

  it('cuts a long account name to the 128 code points the column holds', async () => {
    await run({ album_id: 9 }, [[{ id: 9 }], [{ name: 'é'.repeat(200) }], [noteRow]]);
    expect(inserted[0].reported_by).toBe('é'.repeat(128));
  });

  it.each([
    ['no account row', []],
    ['an account with no name', [{ name: null }]],
  ])('%s: refused, and nothing is written', async (_name, rows) => {
    const result = await run({ album_id: 9 }, [[{ id: 9 }], rows]);
    expect(result).toEqual({ outcome: 'no_account' });
    expect(inserted).toEqual([]);
  });

  it('a release that does not exist is unknown_subject, with no retry and no insert', async () => {
    expect(await run({ album_id: 9 }, [[]])).toEqual({ outcome: 'unknown_subject' });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([]);
  });

  it('an item that does not exist is unknown_subject after the one retry, with no insert', async () => {
    expect(await run({ intake_item_id: 4 }, [[], []])).toEqual({ outcome: 'unknown_subject' });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(inserted).toEqual([]);
  });

  it('an item filed between the unlocked read and the lock: the retry locks the release first and stamps it, and the first attempt never inserts', async () => {
    const result = await run({ intake_item_id: 4 }, [
      [unfiled],
      [filed],
      [filed],
      [{ id: 9 }],
      [filed],
      [account],
      [noteRow],
    ]);
    expect(result.outcome).toBe('created');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(log).toEqual([
      'intake_items for share id 4',
      'library for key share id 9',
      'intake_items for share id 4',
      'insert fcc_notes',
    ]);
    expect(inserted).toEqual([expect.objectContaining({ intake_item_id: 4, album_id: 9 })]);
  });
});

describe('FccNote reads (BS#2862)', () => {
  const { builder } = createLockLog();
  const dialect = new PgDialect();
  afterEach(() => jest.restoreAllMocks());

  it('the record is the library release when there is one, else the intake item', () => {
    expect(dialect.sqlToQuery(fccNoteSelection.artist_name.getSQL()).sql).toBe(
      'coalesce("wxyc_schema"."artists"."artist_name", "wxyc_schema"."intake_items"."artist_name")'
    );
    expect(dialect.sqlToQuery(fccNoteSelection.album_title.getSQL()).sql).toBe(
      'coalesce("wxyc_schema"."library"."album_title", "wxyc_schema"."intake_items"."album_title")'
    );
  });

  it('a list is one statement, however many notes it returns', async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const select = jest.spyOn(db, 'select').mockReturnValue(builder(rows) as never);
    expect(await listFccNotes({ album_id: 9 })).toEqual(rows);
    expect(await listFccNotes({ intake_item_id: 4 })).toEqual(rows);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('selectFccNotes left-joins the release, its artist and the item, so a note with either subject has a record', () => {
    const calls: string[] = [];
    const chain: Record<string, unknown> = {};
    const record = (name: string) => () => {
      calls.push(name);
      return chain;
    };
    for (const name of ['from', 'leftJoin']) chain[name] = record(name);
    selectFccNotes({ select: () => chain } as never);
    expect(calls).toEqual(['from', 'leftJoin', 'leftJoin', 'leftJoin']);
  });
});
