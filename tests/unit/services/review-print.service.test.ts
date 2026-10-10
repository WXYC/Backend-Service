/**
 * `printIntakeItem` / `printSlip` (BS#2804): which review prints, the lock order and the retry, the print-log row and the
 * slip, against a stand-in transaction (the concurrency against real rows is `tests/integration/intake-print.spec.js`).
 * Real schema, as in `intake.file.service.test.ts`; every lock is spelled by `createLockLog()`.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

import { getTableName, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { printIntakeItem, printReleaseReview } from '../../../apps/backend/services/review-print.service';
import { reviewInReleaseList } from '../../../apps/backend/services/reviews.service';
import { createLockLog } from '../../utils/lock-log-builder';

const { builder, log, sets, setsByTable, wheres } = createLockLog();

const unfiled = { album_id: null, state: 'reviewed' };
const filed = { album_id: 9, state: 'filed' };
const item = { artist_name: 'Juana Molina', album_title: 'DOGA', record_label: 'Sonamos', accepted_review_id: 3 };
const submittedAt = new Date('2026-09-01T12:00:00Z');
const review = {
  id: 3,
  medium: 'typed',
  author: 'Test Reviewer',
  author_user_id: 'dj-1',
  submitted_at: submittedAt,
  last_modified: new Date('2026-09-02T12:00:00Z'),
  // What the row says now; the slip reads the revision instead.
  review: 'edited text',
  artist_blurb: null,
  buzzwords: null,
  recommended_tracks: null,
  fcc: null,
};
const revision = {
  id: 55,
  review_id: 3,
  revision: 2,
  review: 'printed text',
  artist_blurb: 'blurb',
  buzzwords: 'folk, electronic',
  recommended_tracks: 'la paradoja',
  fcc: 'clean',
};

type Inserted = [string, Record<string, unknown>];

/** Runs the print against a queue of select answers; every insert is recorded with its table. */
const run = async (selects: unknown[][], id = 7) => {
  log.length = 0;
  sets.length = 0;
  for (const key of Object.keys(setsByTable)) delete setsByTable[key];
  const inserts: Inserted[] = [];
  const tx = {
    select: jest.fn(() => builder(selects.shift() ?? [])),
    insert: jest.fn((table: never) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserts.push([getTableName(table), values]);
        return Promise.resolve();
      }),
    })),
    update: jest.fn((table: never) => builder([], undefined, getTableName(table))),
  };
  const transaction = jest
    .spyOn(db, 'transaction')
    .mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
  const result = await printIntakeItem(id, { id: 'md-1' });
  return { result, inserts, tx, transaction };
};

/** The selects of one successful print of a filed item whose review already has history. */
const filedPrint = (overrides: { item?: object; review?: object } = {}) => [
  [filed],
  [{ id: 9 }],
  [filed],
  [{ ...item, ...overrides.item }],
  [{ ...review, ...overrides.review }],
  [{ n: 2 }],
  [revision],
];

afterEach(() => jest.restoreAllMocks());

describe('printIntakeItem locks (BS#2804)', () => {
  it('locks a filed item’s library row, then the item, then the review', async () => {
    await run(filedPrint());
    expect(log).toEqual(['library for key share id 9', 'intake_items for update id 7', 'reviews for update id 3']);
  });

  it('takes no library lock for an unfiled item', async () => {
    await run([[unfiled], [unfiled], [item], [review], [{ n: 2 }], [revision]]);
    expect(log).toEqual(['intake_items for update id 7', 'reviews for update id 3']);
  });

  it('retries once when the item was filed between the read and the lock, writing nothing the first time', async () => {
    const { result, inserts, transaction } = await run([
      [unfiled],
      [filed], // the first attempt: unfiled at the read, filed once locked
      ...filedPrint(),
    ]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(log).toEqual([
      'intake_items for update id 7',
      'library for key share id 9',
      'intake_items for update id 7',
      'reviews for update id 3',
    ]);
    expect(inserts.map(([table, values]) => [table, values.album_id])).toEqual([['review_prints', 9]]);
    expect(result.outcome).toBe('printed');
  });

  it('answers not_found when the retry also gets undefined, writing nothing', async () => {
    const { result, inserts, tx, transaction } = await run([[unfiled], [filed], [], []]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ outcome: 'not_found' });
    expect(inserts).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe('printIntakeItem refusals (BS#2804)', () => {
  it.each([
    ['an item with no accepted review', filedPrint({ item: { accepted_review_id: null } }).slice(0, 4), 'not_reviewed'],
    ['a handwritten accepted review', filedPrint({ review: { medium: 'handwritten' } }), 'handwritten'],
  ])('%s is %s and writes nothing', async (_name, selects, outcome) => {
    const { result, inserts, tx } = await run(selects);
    expect(result).toEqual({ outcome });
    expect(inserts).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe('printIntakeItem writes (BS#2804)', () => {
  it('appends a print-log row naming the review, its highest revision and the item’s release, then stamps the item', async () => {
    const { result, inserts } = await run(filedPrint());
    expect(inserts).toEqual([
      ['review_prints', { intake_item_id: 7, album_id: 9, review_id: 3, revision_id: 55, printed_by: 'md-1' }],
    ]);
    expect(sets).toEqual([expect.objectContaining({ printed_by: 'md-1' })]);
    expect(sets[0]).toHaveProperty('printed_at');
    expect(result.outcome).toBe('printed');
  });

  it('prints an unfiled item with a null album_id', async () => {
    const { inserts } = await run([[unfiled], [unfiled], [item], [review], [{ n: 2 }], [revision]]);
    expect(inserts[0][1]).toMatchObject({ intake_item_id: 7, album_id: null });
  });

  it('builds the slip from this item’s record and the printed revision’s text', async () => {
    const { result } = await run(filedPrint());
    expect(result).toEqual({
      outcome: 'printed',
      slip: {
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        record_label: 'Sonamos',
        buzzwords: 'folk, electronic',
        artist_blurb: 'blurb',
        review: 'printed text',
        author: 'Test Reviewer',
        submitted_at: submittedAt,
        recommended_tracks: 'la paradoja',
        fcc: 'clean',
        revision_id: 55,
        fcc_notes: [],
      },
    });
  });

  it('fills fcc_notes from the confirmed notes read after the print-log row, in the order read', async () => {
    const notes = [
      { track: 'la paradoja', note: 'A placeholder note.' },
      { track: 'B2', note: 'Another placeholder note.' },
    ];
    const { result } = await run([...filedPrint(), notes]);
    expect(result).toMatchObject({ outcome: 'printed', slip: { fcc_notes: notes } });
  });

  it('writes revision 1 first for a submitted review with no history, at submitted_at and attributed to its author', async () => {
    const { inserts } = await run([
      [unfiled],
      [unfiled],
      [item],
      [review],
      [{ n: 0 }],
      [{ id: 5 }],
      [{ n: 0 }],
      [revision],
    ]);
    expect(inserts.map(([table]) => table)).toEqual(['review_revisions', 'review_prints']);
    expect(inserts[0][1]).toMatchObject({
      review_id: 3,
      revision: 1,
      edited_by: 'Test Reviewer',
      edited_by_user_id: 'dj-1',
      edited_at: submittedAt,
      review: 'edited text',
    });
    expect(inserts[1][1]).toMatchObject({ revision_id: 55 });
  });

  it('falls back to last_modified when the review has no submitted_at', async () => {
    const { inserts } = await run([
      [unfiled],
      [unfiled],
      [item],
      [{ ...review, submitted_at: null }],
      [{ n: 0 }],
      [{ id: 5 }],
      [{ n: 0 }],
      [revision],
    ]);
    expect(inserts[0][1]).toMatchObject({ edited_at: review.last_modified });
  });
});

describe('printReleaseReview (BS#2865)', () => {
  const record = { artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again', record_label: 'Drag City' };
  const typed = { ...review, status: 'submitted' };

  /** The selects of one print of a release with no copy: the release lock, the copy read, the review, the record, then printSlip's own reads. */
  const releasePrint = (overrides: { release?: unknown[]; review?: unknown[] } = {}) => [
    overrides.release ?? [{ id: 12 }],
    [],
    overrides.review ?? [typed],
    [record],
    [{ n: 2 }],
    [revision],
  ];

  const runRelease = async (selects: unknown[][]) => {
    log.length = 0;
    wheres.length = 0;
    sets.length = 0;
    for (const key of Object.keys(setsByTable)) delete setsByTable[key];
    const inserts: Inserted[] = [];
    const tx = {
      select: jest.fn(() => builder(selects.shift() ?? [])),
      insert: jest.fn((table: never) => ({
        values: jest.fn((values: Record<string, unknown>) => {
          inserts.push([getTableName(table), values]);
          return Promise.resolve();
        }),
      })),
      update: jest.fn((table: never) => builder([], undefined, getTableName(table))),
    };
    jest.spyOn(db, 'transaction').mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    const result = await printReleaseReview(12, 3, { id: 'md-1' });
    return { result, inserts, tx };
  };

  it('locks the release for key share, then the review for update, and never an intake item', async () => {
    await runRelease(releasePrint());
    expect(log).toEqual(['library for key share id 12', 'reviews for update id 3']);
  });

  it('appends one print-log row with no intake item and builds the slip from the library row', async () => {
    const { result, inserts, tx } = await runRelease(releasePrint());
    expect(inserts).toEqual([
      ['review_prints', { intake_item_id: null, album_id: 12, review_id: 3, revision_id: 55, printed_by: 'md-1' }],
    ]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'printed',
      slip: {
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        record_label: 'Drag City',
        revision_id: 55,
      },
    });
  });

  it('selects the review under the release’s membership rule, binding the review id and the release id', async () => {
    await runRelease(releasePrint());
    const dialect = new PgDialect();
    const [reviewWhere] = wheres.map((w) => dialect.sqlToQuery(w)).filter((q) => q.sql.includes('"reviews"."id"'));
    expect(reviewWhere.sql).toBe(
      '("wxyc_schema"."reviews"."id" = $1 and ("wxyc_schema"."reviews"."album_id" = $2 OR "wxyc_schema"."reviews"."album_id" IN (SELECT ci.cited_album_id FROM "wxyc_schema"."intake_items" AS ci WHERE ci.album_id = $3 AND ci.state IN ($4, $5) AND ci.cited_album_id IS NOT NULL)))'
    );
    expect(reviewWhere.params).toEqual([3, 12, 12, 'filed', 'finalized']);
  });

  it('names the release’s displayed artist on the slip: its alternate artist name when set, else the artist’s name', async () => {
    const { tx } = await runRelease(releasePrint());
    const { artist_name } = tx.select.mock.calls[3][0] as unknown as { artist_name: SQL };
    expect(new PgDialect().sqlToQuery(artist_name).sql).toBe(
      'coalesce(nullif("wxyc_schema"."library"."alternate_artist_name", \'\'), "wxyc_schema"."artists"."artist_name")'
    );
  });

  it('answers not_found for an unknown release without reading a review', async () => {
    const { result, inserts, tx } = await runRelease(releasePrint({ release: [] }));
    expect(result).toEqual({ outcome: 'not_found' });
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([]);
  });

  describe('a release with one logged copy (BS#3075)', () => {
    const copy = { id: 41, cited: null };
    const citing = { id: 41, cited: 5 };
    const other = { id: 42, cited: null };
    const afterLocks = (r: object = { ...typed, album_id: 12 }) => [[r], [record], [{ n: 2 }], [revision]];
    /** The selects after the release lock: the unlocked copy read, the citation's peek and lock, the locked copy read. */
    const copyReads = (read: object[], locked: object[], citation: unknown[][] = []) => [
      read,
      ...(read.length === 1 ? [...citation, locked] : []),
    ];
    const peek = [[{ album: 5 }], [{ id: 5 }]];

    // A print counts for the release's one filed or finalized copy; none, or several, keep the print with no item.
    it.each([
      ['no copy', [], [], null],
      ['one copy', [copy], [copy], 41],
      ['two copies', [copy, other], [], null],
      ['a copy gone between the read and the lock', [copy], [], null],
      // Filing takes the library row only FOR KEY SHARE, so a second copy can land between the two reads: it makes two, and the print takes no item.
      ['a second copy filed between the read and the lock', [copy], [copy, other], null],
    ])('%s: the print row names item %p', async (_name, read, locked, itemId) => {
      const { result, inserts, tx } = await runRelease([[{ id: 12 }], ...copyReads(read, locked), ...afterLocks()]);
      expect(result.outcome).toBe('printed');
      expect(inserts).toEqual([
        ['review_prints', { intake_item_id: itemId, album_id: 12, review_id: 3, revision_id: 55, printed_by: 'md-1' }],
      ]);
      if (itemId === null) {
        expect(tx.update).not.toHaveBeenCalled();
      } else {
        expect(sets).toEqual([
          expect.objectContaining({ accepted_review_id: 3, accepted_by: 'md-1' }),
          expect.objectContaining({ printed_by: 'md-1' }),
        ]);
        expect(sets[1]).toHaveProperty('printed_at');
      }
    });

    // Only a filed or finalized item is a copy of the release. `album_id` is set by filing alone, so today the filter excludes no row a
    // real release holds (equivalent in practice); this pins the predicate itself, for the day an item carries a release without being filed.
    it.each([
      ['the unlocked read', 0],
      ['the locked read', 1],
    ])('%s asks for this release’s filed and finalized items only', async (_name, which) => {
      await runRelease([[{ id: 12 }], ...copyReads([copy], [copy]), ...afterLocks()]);
      const dialect = new PgDialect();
      const [read, locked] = wheres.map((w) => dialect.sqlToQuery(w)).filter((q) => q.sql.includes('"album_id"'));
      const { sql: text, params } = [read, locked][which];
      expect(text).toBe(
        '("wxyc_schema"."intake_items"."album_id" = $1 and "wxyc_schema"."intake_items"."state" in ($2, $3))'
      );
      expect(params).toEqual([12, 'filed', 'finalized']);
    });

    it('locks the library row, the copy, then the review', async () => {
      await runRelease([[{ id: 12 }], ...copyReads([copy], [copy]), ...afterLocks()]);
      expect(log).toEqual(['library for key share id 12', 'intake_items for update id 12', 'reviews for update id 3']);
    });

    it('locks the cited release for share before the copy when the review is the citation’s', async () => {
      const { inserts } = await runRelease([
        [{ id: 12 }],
        ...copyReads([citing], [citing], peek),
        ...afterLocks({ ...typed, album_id: 5, intake_item_id: null }),
      ]);
      expect(log).toEqual([
        'library for key share id 12',
        'library for share id 5',
        'intake_items for update id 12',
        'reviews for update id 3',
      ]);
      expect(inserts[0][1]).toMatchObject({ intake_item_id: 41, album_id: 12 });
    });

    it.each([
      ['the copy’s own', { album_id: null, intake_item_id: 41 }],
      ['the release’s', { album_id: 12, intake_item_id: null }],
    ])('%s review belongs to the copy', async (_name, fields) => {
      const { result } = await runRelease([
        [{ id: 12 }],
        ...copyReads([copy], [copy]),
        ...afterLocks({ ...typed, ...fields }),
      ]);
      expect(result.outcome).toBe('printed');
    });

    it('answers bad_review and writes nothing for a citation’s review the locked copy no longer cites', async () => {
      const { result, inserts, tx } = await runRelease([
        [{ id: 12 }],
        ...copyReads([citing], [copy], peek),
        ...afterLocks({ ...typed, album_id: 5, intake_item_id: null }),
      ]);
      expect(result).toEqual({ outcome: 'bad_review' });
      expect(inserts).toEqual([]);
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['an unknown review, or one outside the release’s list', []],
    ['a draft', [{ ...typed, status: 'draft' }]],
    ['a handwritten review', [{ ...typed, medium: 'handwritten' }]],
  ])('%s is bad_review and writes nothing', async (_name, found) => {
    const { result, inserts } = await runRelease(releasePrint({ review: found }));
    expect(result).toEqual({ outcome: 'bad_review' });
    expect(inserts).toEqual([]);
  });
});

describe('reviewInReleaseList (BS#2865)', () => {
  it('matches the release’s own reviews and those of a release a filed or finalized copy cites', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(reviewInReleaseList(12));
    expect(text).toBe(
      '("wxyc_schema"."reviews"."album_id" = $1 OR "wxyc_schema"."reviews"."album_id" IN (SELECT ci.cited_album_id FROM "wxyc_schema"."intake_items" AS ci WHERE ci.album_id = $2 AND ci.state IN ($3, $4) AND ci.cited_album_id IS NOT NULL))'
    );
    expect(params).toEqual([12, 12, 'filed', 'finalized']);
  });
});
