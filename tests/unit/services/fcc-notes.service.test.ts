/**
 * `/fcc-notes` create and list (BS#2862) and confirm, delete, the waiting list and the slip's notes (BS#2863): the lock
 * order, the retry, what is written and the one-statement list, against a stand-in transaction. Real schema, as in `intake.file.service.test.ts`; the SQL against real rows is
 * `tests/integration/fcc-notes.spec.js`.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db, staffNameSql, user } from '@wxyc/database';
import {
  confirmedFccNotesOf,
  confirmFccNote,
  createFccNote,
  deleteFccNote,
  fccNoteSelection,
  listFccNotes,
  listReportedFccNotes,
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
  let reporterLookups: unknown[];

  const run = async (subject: Parameters<typeof createFccNote>[0], selects: unknown[][]) => {
    log.length = 0;
    inserted = [];
    reporterLookups = [];
    const queue = selects.map((rows) => [...rows]);
    const tx = {
      select: jest.fn((columns?: Record<string, unknown>) => {
        if (columns && Object.keys(columns).join() === 'name') reporterLookups.push(columns.name);
        return builder(queue.shift() ?? []);
      }),
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

  it('stamps the reporter with the staff name (real name, else account name), looked up once', async () => {
    await run({ album_id: 9 }, [[{ id: 9 }], [account], [noteRow]]);
    expect(reporterLookups.map((c) => render(c).sql)).toEqual([render(staffNameSql(user)).sql]);
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

const { builder, callsOf } = createLockLog();
const dialect = new PgDialect();
const render = (query: unknown) => {
  const { sql, params } = dialect.sqlToQuery(query as never);
  return { sql, params };
};
const T = '"wxyc_schema"."fcc_notes"';

describe('confirmFccNote (BS#2863)', () => {
  const actor = { id: 'md-1' };
  const note = { id: 5, status: 'confirmed', confirmed_by: 'Test Reviewer', artist_name: 'Juana Molina' };
  afterEach(() => jest.restoreAllMocks());

  /** `returned` is what the UPDATE's RETURNING gives, `notes` what the read after it gives (both inside one transaction). */
  const run = async (account: unknown[], returned: unknown[], notes: unknown[]) => {
    const accountQuery = builder(account);
    const updateQuery = builder(returned);
    const readQuery = builder(notes);
    const select = jest.spyOn(db, 'select').mockReturnValueOnce(accountQuery as never);
    const tx = { update: jest.fn(() => updateQuery), select: jest.fn(() => readQuery) };
    const transaction = jest
      .spyOn(db, 'transaction')
      .mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    const update = callsOf(updateQuery);
    return { result: await confirmFccNote(5, actor), account: callsOf(accountQuery), update, select, transaction, tx };
  };

  it('stamps the confirmer by their account name and the time, in one UPDATE that only matches a reported note', async () => {
    const { result, update, transaction, tx } = await run([{ name: 'Test Reviewer' }], [{ id: 5 }], [note]);
    expect(result).toMatchObject({ outcome: 'confirmed', note });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    const set = update.set[0] as Record<string, unknown>;
    expect(set).toMatchObject({ status: 'confirmed', confirmed_by: 'Test Reviewer' });
    expect(set).toHaveProperty('confirmed_at');
    expect(render(update.where[0])).toEqual({
      sql: `(${T}."id" = $1 and ${T}."status" = $2)`,
      params: [5, 'reported'],
    });
    expect(update).toHaveProperty('returning');
  });

  it('answers the row its own UPDATE returned, the read after it only adding the record', async () => {
    const written = { id: 5, status: 'confirmed', confirmed_by: 'Written By Update', confirmed_at: 'T' };
    const stale = { ...note, status: 'reported', confirmed_by: null, confirmed_at: null };
    const { result, tx } = await run([{ name: 'Written By Update' }], [written], [stale]);
    expect(result).toEqual({ outcome: 'confirmed', note: { ...stale, ...written } });
    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it('the confirmer lookup reads the staff name (real name, else account name), keyed by the caller', async () => {
    const { select, account } = await run([{ name: 'Test Reviewer' }], [{ id: 5 }], [note]);
    const columns = select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(columns)).toEqual(['name']);
    expect(render(columns.name as SQL).sql).toBe(render(staffNameSql(user)).sql);
    expect(account.from[0]).toBe(user);
    expect(render(account.where[0])).toEqual({ sql: '"auth_user"."id" = $1', params: ['md-1'] });
  });

  it('confirming a note already confirmed answers the note as it is: the UPDATE matches nothing and the read returns it', async () => {
    const { result } = await run([{ name: 'Second Confirmer' }], [], [note]);
    expect(result).toEqual({ outcome: 'confirmed', note });
  });

  it('a note that is not there is not_found', async () => {
    expect((await run([{ name: 'Test Reviewer' }], [], [])).result).toEqual({ outcome: 'not_found' });
  });

  it.each([
    ['no account row', []],
    ['an account with no name', [{ name: null }]],
  ])('%s: refused, and nothing is written', async (_name, account) => {
    const update = jest.spyOn(db, 'update');
    const transaction = jest.spyOn(db, 'transaction');
    jest.spyOn(db, 'select').mockReturnValueOnce(builder(account) as never);
    expect(await confirmFccNote(5, actor)).toEqual({ outcome: 'no_account' });
    expect(update).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('deleteFccNote (BS#2863)', () => {
  afterEach(() => jest.restoreAllMocks());

  const run = async (actor: { id: string; manage: boolean }, deleted: unknown[], existing: unknown[] = []) => {
    const deleteQuery = builder(deleted);
    jest.spyOn(db, 'delete').mockReturnValue(deleteQuery as never);
    const select = jest.spyOn(db, 'select').mockReturnValue(builder(existing) as never);
    return { result: await deleteFccNote(5, actor), del: callsOf(deleteQuery), select };
  };

  it('a caller without reviews: manage: the WHERE carries the note, the reporter and the reported status', async () => {
    const { result, del } = await run({ id: 'dj-1', manage: false }, [{ id: 5 }]);
    expect(result).toEqual({ outcome: 'deleted' });
    expect(render(del.where[0])).toEqual({
      sql: `(${T}."id" = $1 and (${T}."reported_by_user_id" = $2 and ${T}."status" = $3))`,
      params: [5, 'dj-1', 'reported'],
    });
  });

  it('a music director: the WHERE is the note alone, so a confirmed one goes too', async () => {
    const { result, del } = await run({ id: 'md-1', manage: true }, [{ id: 5 }]);
    expect(result).toEqual({ outcome: 'deleted' });
    expect(render(del.where[0])).toEqual({ sql: `${T}."id" = $1`, params: [5] });
  });

  it('a delete that matches nothing is forbidden when the note exists (another DJ, or the reporter after the confirm) and not_found when it does not', async () => {
    expect((await run({ id: 'dj-2', manage: false }, [], [{ id: 5 }])).result).toEqual({ outcome: 'forbidden' });
    expect((await run({ id: 'dj-2', manage: false }, [], [])).result).toEqual({ outcome: 'not_found' });
  });

  it('a delete that matches a row never reads again', async () => {
    const { select } = await run({ id: 'dj-1', manage: false }, [{ id: 5 }]);
    expect(select).not.toHaveBeenCalled();
  });
});

describe('the waiting list and the slip’s notes (BS#2863)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('the waiting list is one statement over every reported note, oldest first', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const query = builder(rows);
    const calls = callsOf(query);
    const select = jest.spyOn(db, 'select').mockReturnValue(query as never);
    expect(await listReportedFccNotes()).toEqual(rows);
    expect(select).toHaveBeenCalledTimes(1);
    expect(render(calls.where[0])).toEqual({ sql: `${T}."status" = $1`, params: ['reported'] });
    expect((calls.orderBy as { getSQL(): never }[]).map((o) => render(o.getSQL()).sql)).toEqual([
      `${T}."reported_at" asc`,
      `${T}."id" asc`,
    ]);
  });

  it('a record list sent with a status keeps only that status', async () => {
    const query = builder([]);
    jest.spyOn(db, 'select').mockReturnValue(query as never);
    await listFccNotes({ album_id: 9, status: 'confirmed' });
    expect(render(callsOf(query).where[0])).toEqual({
      sql: `(${T}."album_id" = $1 and ${T}."status" = $2)`,
      params: [9, 'confirmed'],
    });
  });

  it.each([
    [
      'an item',
      { intake_item_id: 4, album_id: null },
      `(${T}."status" = $1 and ${T}."intake_item_id" = $2)`,
      ['confirmed', 4],
    ],
    [
      'a release',
      { intake_item_id: null, album_id: 9 },
      `(${T}."status" = $1 and ${T}."album_id" = $2)`,
      ['confirmed', 9],
    ],
    [
      'a filed item, by its item or its release',
      { intake_item_id: 4, album_id: 9 },
      `(${T}."status" = $1 and (${T}."intake_item_id" = $2 or ${T}."album_id" = $3))`,
      ['confirmed', 4, 9],
    ],
  ])(
    'the slip’s notes of %s: only confirmed, by the target’s subject, oldest first',
    async (_name, target, sql, params) => {
      const rows = [{ track: 'B2', note: 'a word' }];
      const query = builder(rows);
      const calls = callsOf(query);
      expect(await confirmedFccNotesOf({ select: () => query } as never, target)).toEqual(rows);
      expect(render(calls.where[0])).toEqual({ sql, params });
      expect((calls.orderBy as { getSQL(): never }[]).map((o) => render(o.getSQL()).sql)).toEqual([
        `${T}."reported_at" asc`,
        `${T}."id" asc`,
      ]);
    }
  );

  it('a target with neither subject reads nothing, never every confirmed note', async () => {
    const select = jest.fn();
    expect(await confirmedFccNotesOf({ select } as never, { intake_item_id: null, album_id: null })).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
