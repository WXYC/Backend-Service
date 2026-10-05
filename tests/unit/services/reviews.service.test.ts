/**
 * `/reviews` create and edit (BS#2802). The editing rules and the author snapshot are pure and
 * pinned directly; `createReview`/`updateReview` run against a scripted fake `db` so the
 * outcomes and what they write are pinned without Postgres (the SQL itself is exercised by
 * tests/integration/reviews.spec.js).
 */
jest.unmock('drizzle-orm');

const mockQueue: unknown[][] = [];
let mockUpdatedRow: Record<string, unknown> = {};
const mockWrites: { inserted?: Record<string, unknown>; updated?: Record<string, unknown> } = {};
/** Every insert, in order, with the table it targeted. */
const mockInserts: { table: string; values: Record<string, unknown> }[] = [];
/** Every statement that touched the database, in order: `select <table>` / `update` / `insert <table>`. */
const mockStatements: string[] = [];
/** Every select, in order: which handle ran it (`db` outside the transaction, `tx` inside), its table, its lock and its rendered WHERE. */
const mockReads: { handle: 'db' | 'tx'; table: string; lock?: string; of?: string; where: string }[] = [];

// The default unit stub for the auth package has no `roleGrants`; `holdsReviewsManage` needs the real one.
jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.roles'));

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  // A thenable chain: whatever the builder is awaited on resolves the next scripted result set.
  const chain = (handle: 'db' | 'tx'): any => {
    const { PgDialect, getTableName } = {
      PgDialect: jest.requireActual('drizzle-orm/pg-core').PgDialect,
      getTableName: jest.requireActual('drizzle-orm').getTableName,
    };
    const read: (typeof mockReads)[number] = { handle, table: '', where: '' };
    mockReads.push(read);
    mockStatements.push(`select#${mockReads.length - 1}`);
    const c: any = {
      from: (t: any) => {
        read.table = getTableName(t);
        return c;
      },
      leftJoin: () => c,
      where: (w: any) => {
        const q = new PgDialect().sqlToQuery(w);
        read.where = `${q.sql} ${JSON.stringify(q.params)}`;
        return c;
      },
      for: (mode: string, config?: { of?: any }) => {
        read.lock = mode;
        if (config?.of) read.of = getTableName(config.of);
        return c;
      },
      then: (resolve: any, reject: any) => Promise.resolve(mockQueue.shift()).then(resolve, reject),
    };
    return c;
  };
  const tx = {
    select: () => chain('tx'),
    insert: (t: any) => ({
      values: (v: Record<string, unknown>) => {
        mockWrites.inserted = v;
        mockInserts.push({ table: jest.requireActual('drizzle-orm').getTableName(t), values: v });
        mockStatements.push(`insert ${mockInserts[mockInserts.length - 1].table}`);
        return { returning: () => Promise.resolve([{ id: 11 }]) };
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        mockWrites.updated = s;
        mockStatements.push('update');
        return { where: () => ({ returning: () => Promise.resolve([mockUpdatedRow]) }) };
      },
    }),
  };
  return { ...realSchema, db: { ...tx, select: () => chain('db'), transaction: (cb: any) => cb(tx) } };
});

import { FILED_STATES, effectiveState } from '../../../apps/backend/services/intake.service';
import {
  AUTHOR_MAX,
  createReview,
  editOutcome,
  lockReviewAfterItem,
  snapshotAuthor,
  updateReview,
  writeReviewRevision,
} from '../../../apps/backend/services/reviews.service';
import { holdsReviewsManage } from '../../../apps/backend/utils/review-grants';

const DJ = { id: 'dj-1', manage: false };
const MD = { id: 'md-1', manage: true };

beforeEach(() => {
  mockQueue.length = 0;
  mockReads.length = 0;
  mockInserts.length = 0;
  mockStatements.length = 0;
  mockUpdatedRow = {};
  delete mockWrites.inserted;
  delete mockWrites.updated;
});

describe('the intake seam this slice builds on', () => {
  test('intake.service exports effectiveState and FILED_STATES', () => {
    expect(effectiveState).toBeDefined();
    expect(FILED_STATES).toEqual(['filed', 'finalized']);
  });

  test.each([
    ['stationManager', true],
    ['musicDirector', true],
    ['dj', false],
    [undefined, false],
  ])('holdsReviewsManage(%s) is %s', (role, expected) => {
    expect(holdsReviewsManage({ auth: { role } } as any)).toBe(expected);
  });
});

describe('snapshotAuthor', () => {
  test('keeps a short name whole', () => {
    expect(snapshotAuthor('Cat Power')).toBe('Cat Power');
  });

  test.each([['a'], ['😀']])('cuts a 200-code-point name of %s to its first 128 code points', (ch) => {
    const out = snapshotAuthor(ch.repeat(200));
    expect([...out]).toHaveLength(AUTHOR_MAX);
    expect(out).toBe(ch.repeat(128));
  });

  test('has no name to snapshot for a missing account', () => {
    expect(snapshotAuthor(undefined)).toBeNull();
  });
});

describe('editOutcome', () => {
  const review = (o: object) => ({
    status: 'submitted' as const,
    author_user_id: 'dj-1',
    recorded_by_user_id: null,
    ...o,
  });
  const OTHER_DJ = { id: 'dj-2', manage: false };

  test.each([
    ['the author edits their draft', review({ status: 'draft' }), DJ, false, 'allowed'],
    ['the author edits a submitted review, printed or not', review({}), DJ, false, 'allowed'],
    ['another DJ edits a submitted review', review({}), OTHER_DJ, false, 'forbidden'],
    ['another DJ edits a draft: not visible', review({ status: 'draft' }), OTHER_DJ, false, 'not_found'],
    ['a music director edits any submitted review', review({}), MD, false, 'allowed'],
    // Draft privacy outranks manage: only the author and whoever recorded it may see a draft.
    ["a music director edits another user's draft: not visible", review({ status: 'draft' }), MD, false, 'not_found'],
    [
      'the recorder edits an on-behalf draft',
      review({ status: 'draft', author_user_id: null, recorded_by_user_id: 'md-1' }),
      MD,
      false,
      'allowed',
    ],
    // Consent belongs to the author's account, whatever the caller's grants. A caller who may
    // edit but is not the author gets the distinct consent_forbidden; one who may not edit at
    // all stays forbidden, so the refusal names the right thing.
    ['the author sets consent', review({}), DJ, true, 'allowed'],
    ['the author sets consent on their draft', review({ status: 'draft' }), DJ, true, 'allowed'],
    ["a music director sets consent on someone else's review", review({}), MD, true, 'consent_forbidden'],
    [
      'a music director sets consent on a review with no linked account',
      review({ author_user_id: null }),
      MD,
      true,
      'consent_forbidden',
    ],
    [
      'the recorder sets consent on an on-behalf draft',
      review({ status: 'draft', author_user_id: null, recorded_by_user_id: 'md-1' }),
      MD,
      true,
      'consent_forbidden',
    ],
    ["another DJ's consent patch on a submitted review is forbidden outright", review({}), OTHER_DJ, true, 'forbidden'],
    [
      "another DJ's consent patch on a draft is still not_found",
      review({ status: 'draft' }),
      OTHER_DJ,
      true,
      'not_found',
    ],
    ['a music director edits the text of a review whose consent they may not set', review({}), MD, false, 'allowed'],
  ])('%s', (_name, r, actor, touchesConsent, expected) => {
    expect(editOutcome(r, actor, touchesConsent)).toBe(expected);
  });

  test.each([DJ, MD, { id: 'dj-2', manage: false }])('no outcome is locked, whoever asks (%j)', (actor) => {
    for (const status of ['draft', 'submitted'] as const) {
      for (const touchesConsent of [false, true]) {
        expect(editOutcome(review({ status }), actor, touchesConsent)).not.toBe('locked');
      }
    }
  });
});

describe('createReview', () => {
  const created = { id: 11 };

  test('snapshots a 200-code-point account name as its first 128 code points', async () => {
    mockQueue.push([{ id: 4 }], [{ name: 'n'.repeat(200) }], [created]);
    const result = await createReview({ intake_item_id: 4 }, { review: 'text' }, DJ);
    expect(result).toEqual({ outcome: 'created', review: created });
    expect(mockWrites.inserted).toMatchObject({
      intake_item_id: 4,
      review: 'text',
      author: 'n'.repeat(128),
      author_user_id: 'dj-1',
      medium: 'typed',
      status: 'draft',
    });
  });

  test('an intake item the caller does not hold is subject_not_held and writes nothing', async () => {
    mockQueue.push([]);
    expect(await createReview({ intake_item_id: 4 }, {}, DJ)).toEqual({ outcome: 'subject_not_held' });
    expect(mockWrites.inserted).toBeUndefined();
  });

  test('the hold check reads the item FOR UPDATE inside the transaction, by id, effective state and holder', async () => {
    mockQueue.push([{ id: 4 }], [{ name: 'n' }], [created]);
    await createReview({ intake_item_id: 4 }, {}, DJ);
    const hold = mockReads[0];
    expect(hold).toMatchObject({ handle: 'tx', table: 'intake_items', lock: 'update' });
    expect(hold.where).toContain(`'checked_out'`);
    expect(hold.where).toMatch(/"checked_out_by" = \$\d+/);
    expect(hold.where).toContain('[4,"dj-1"]');
    expect(mockReads.every((r) => r.handle === 'tx')).toBe(true);
  });

  test('a library release that does not exist is subject_not_held', async () => {
    mockQueue.push([]);
    expect(await createReview({ album_id: 9 }, {}, DJ)).toEqual({ outcome: 'subject_not_held' });
  });

  test('any DJ may review a library release', async () => {
    mockQueue.push([{ id: 9 }], [{ name: 'Jessica Pratt' }], [created]);
    expect((await createReview({ album_id: 9 }, {}, DJ)).outcome).toBe('created');
    expect(mockWrites.inserted).toMatchObject({ album_id: 9, author: 'Jessica Pratt' });
  });
});

describe('lockReviewAfterItem', () => {
  const lock = (mode: 'share' | 'update', id = 3) =>
    lockReviewAfterItem({ select: jest.requireMock('@wxyc/database').db.select }, id, mode);

  test.each(['share', 'update'] as const)('item FOR %s, then the review with a plain FOR UPDATE', async (mode) => {
    mockQueue.push([{ item: 8 }], [{ id: 8 }], [{ id: 3 }]);
    expect(await lock(mode)).toEqual({ itemId: 8 });
    expect(mockReads.map((r) => [r.table, r.lock, r.of])).toEqual([
      ['reviews', undefined, undefined],
      ['intake_items', mode, undefined],
      // No `of`: drizzle renders `FOR UPDATE OF "wxyc_schema"."reviews"`, which Postgres rejects.
      ['reviews', 'update', undefined],
    ]);
    expect(mockReads[1].where).toContain('[8]');
  });

  test('a review on a library release alone has no item to lock', async () => {
    mockQueue.push([{ item: null }], [{ id: 3 }]);
    expect(await lock('update')).toEqual({ itemId: null });
    expect(mockReads.map((r) => [r.table, r.lock])).toEqual([
      ['reviews', undefined],
      ['reviews', 'update'],
    ]);
  });

  test.each([
    ['is missing', [[]]],
    ['vanishes before the lock', [[{ item: null }], []]],
  ])('a review that %s is undefined', async (_name, results) => {
    mockQueue.push(...(results as unknown[][]));
    expect(await lock('share')).toBeUndefined();
  });
});

describe('writeReviewRevision', () => {
  const CONTENT = { review: 'text', artist_blurb: null, buzzwords: 'warm', recommended_tracks: null, fcc: null };
  const write = (n: number | null) => {
    mockQueue.push([{ id: 3 }], [{ n }]);
    return writeReviewRevision(jest.requireMock('@wxyc/database').db, 3, CONTENT, {
      name: 'Test Reviewer',
      userId: 'md-1',
    });
  };

  test('locks the review with a plain FOR UPDATE, reads the highest revision, then inserts and returns the next number', async () => {
    expect(await write(4)).toBe(5);
    expect(mockReads.map((r) => [r.table, r.lock, r.of])).toEqual([
      // No `of`: drizzle renders `FOR UPDATE OF "wxyc_schema"."reviews"`, which Postgres rejects.
      ['reviews', 'update', undefined],
      ['review_revisions', undefined, undefined],
    ]);
    expect(mockStatements).toEqual(['select#0', 'select#1', 'insert review_revisions']);
    expect(mockInserts).toEqual([
      {
        table: 'review_revisions',
        values: { ...CONTENT, review_id: 3, revision: 5, edited_by: 'Test Reviewer', edited_by_user_id: 'md-1' },
      },
    ]);
  });

  test('a review with no history gets revision 1', async () => {
    expect(await write(0)).toBe(1);
    expect(mockInserts[0].values.revision).toBe(1);
  });

  test('a review that does not exist is undefined, decided on the lock before the highest revision is read, and nothing is inserted', async () => {
    mockQueue.push([]);
    const result = await writeReviewRevision(jest.requireMock('@wxyc/database').db, 3, CONTENT, {
      name: 'Test Reviewer',
      userId: 'md-1',
    });
    expect(result).toBeUndefined();
    expect(mockStatements).toEqual(['select#0']);
    expect(mockReads.map((r) => [r.table, r.lock])).toEqual([['reviews', 'update']]);
    expect(mockInserts).toEqual([]);
  });

  test('never locks intake_items', async () => {
    await write(2);
    expect(mockReads.map((r) => r.table)).not.toContain('intake_items');
  });

  test('a stamped time is written as edited_at; none lets the column default apply', async () => {
    mockQueue.push([{ id: 3 }], [{ n: 0 }]);
    const at = new Date('2026-10-01T12:00:00Z');
    await writeReviewRevision(jest.requireMock('@wxyc/database').db, 3, CONTENT, {
      name: null,
      userId: null,
      at,
    });
    expect(mockInserts[0].values).toMatchObject({ edited_at: at, edited_by: null, edited_by_user_id: null });
    await write(0);
    expect(mockInserts[1].values).not.toHaveProperty('edited_at');
  });
});

describe('updateReview', () => {
  const stored = (o: object) => ({
    id: 3,
    status: 'submitted',
    medium: 'typed',
    review: 'kept',
    artist_blurb: null,
    buzzwords: null,
    recommended_tracks: null,
    fcc: null,
    author: 'Cat Power Fan',
    author_user_id: 'dj-1',
    recorded_by_user_id: null,
    submitted_at: new Date('2026-09-30T12:00:00.000Z'),
    last_modified: new Date('2026-09-30T12:30:00.000Z'),
    ...o,
  });
  /** Scripts an edit by `DJ`: lock reads, the current row, then whatever the revision path reads. */
  const script = (current: object, ...more: unknown[][]) =>
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored(current)], ...more);

  test('locks only through lockReviewAfterItem: item FOR SHARE, then the review FOR UPDATE, all in the transaction', async () => {
    mockQueue.push([{ item: 8 }], [{ id: 8 }], [{ id: 3 }], [stored({ status: 'draft' })], [stored({})]);
    mockUpdatedRow = { id: 3 };
    await updateReview(3, { fcc: 'x' }, DJ);
    expect(mockReads.every((r) => r.handle === 'tx')).toBe(true);
    expect(mockReads.map((r) => [r.table, r.lock, r.of])).toEqual([
      ['reviews', undefined, undefined],
      ['intake_items', 'share', undefined],
      ['reviews', 'update', undefined],
      ['reviews', undefined, undefined],
      ['reviews', undefined, undefined],
    ]);
  });

  test('the response is selectReview read after the UPDATE, not the RETURNING row', async () => {
    const reread = stored({ fcc: 'x', note: 'from selectReview' });
    script({ status: 'draft' }, [reread]);
    mockUpdatedRow = { id: 3, fcc: 'x', note: 'from RETURNING' };
    expect(await updateReview(3, { fcc: 'x' }, DJ)).toEqual({ outcome: 'updated', review: reread });
    expect(mockStatements).toEqual(['select#0', 'select#1', 'select#2', 'update', 'select#3']);
  });

  test('the read-back comes after the revision insert too', async () => {
    mockQueue.push(
      [{ item: null }],
      [{ id: 3 }],
      [stored({})],
      [{ name: 'Test Reviewer' }],
      [{ n: 1 }],
      [{ id: 3 }],
      [{ n: 1 }],
      [stored({})]
    );
    mockUpdatedRow = stored({ fcc: 'x' });
    await updateReview(3, { fcc: 'x' }, DJ);
    expect(mockStatements.at(-2)).toBe('insert review_revisions');
    expect(mockStatements.at(-1)).toMatch(/^select#/);
    expect(mockReads.at(-1)).toMatchObject({ handle: 'tx', table: 'reviews' });
    expect(mockReads.at(-1)?.lock).toBeUndefined();
  });

  test('a missing review is not_found', async () => {
    mockQueue.push([]);
    expect(await updateReview(3, { fcc: 'x' }, DJ)).toEqual({ outcome: 'not_found' });
  });

  test('the author of a submitted review edits it and gets 200, whatever the slip', async () => {
    script({}, [{ name: 'Test Reviewer' }], [{ n: 1 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
    mockUpdatedRow = stored({ fcc: 'x' });
    expect((await updateReview(3, { fcc: 'x' }, DJ)).outcome).toBe('updated');
  });

  test('a music director edits any submitted review', async () => {
    script({}, [{ name: 'Test MD' }], [{ n: 1 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
    mockUpdatedRow = stored({ fcc: 'x' });
    expect((await updateReview(3, { fcc: 'x' }, MD)).outcome).toBe('updated');
  });

  test('a patch that would null a submitted typed review text is text_required', async () => {
    script({});
    expect(await updateReview(3, { review: null }, DJ)).toEqual({ outcome: 'text_required' });
    expect(mockWrites.updated).toBeUndefined();
  });

  test.each([
    ['a draft', { status: 'draft' }],
    ['a submitted handwritten review', { medium: 'handwritten' }],
  ])('nulling the text of %s is allowed', async (_name, o) => {
    script(o, [{ name: 'n' }], [{ n: 1 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
    expect((await updateReview(3, { review: null }, DJ)).outcome).toBe('updated');
  });

  test('leaving review out of a patch keeps the stored text, so other fields still save', async () => {
    script({ status: 'draft' }, [stored({})]);
    expect((await updateReview(3, { fcc: 'x' }, DJ)).outcome).toBe('updated');
    expect(mockWrites.updated).toMatchObject({ fcc: 'x' });
  });

  describe('revisions', () => {
    const editor = [{ name: 'Test Reviewer' }];

    test('an edit of a submitted review writes exactly one revision: next number, content as it now stands, editor snapshot and id', async () => {
      script({}, editor, [{ n: 2 }], [{ id: 3 }], [{ n: 2 }], [stored({})]);
      mockUpdatedRow = stored({ review: 'new', fcc: 'x', buzzwords: 'warm' });
      await updateReview(3, { review: 'new', fcc: 'x' }, DJ);
      expect(mockInserts).toEqual([
        {
          table: 'review_revisions',
          values: {
            review_id: 3,
            revision: 3,
            review: 'new',
            artist_blurb: null,
            buzzwords: 'warm',
            recommended_tracks: null,
            fcc: 'x',
            edited_by: 'Test Reviewer',
            edited_by_user_id: 'dj-1',
          },
        },
      ]);
    });

    test("a music director's edit is in the history under the director's name and id", async () => {
      script({}, [{ name: 'Test MD' }], [{ n: 1 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
      mockUpdatedRow = stored({ fcc: 'x' });
      await updateReview(3, { fcc: 'x' }, MD);
      expect(mockInserts[0].values).toMatchObject({ revision: 2, edited_by: 'Test MD', edited_by_user_id: 'md-1' });
    });

    test('a long account name is cut to 128 code points like reviews.author', async () => {
      script({}, [{ name: 'n'.repeat(200) }], [{ n: 1 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
      mockUpdatedRow = stored({ fcc: 'x' });
      await updateReview(3, { fcc: 'x' }, DJ);
      expect(mockInserts[0].values.edited_by).toBe('n'.repeat(128));
    });

    test('a draft edit writes none', async () => {
      script({ status: 'draft' }, [stored({})]);
      await updateReview(3, { fcc: 'x' }, DJ);
      expect(mockInserts).toEqual([]);
    });

    test('a consent-only edit of a submitted review writes none', async () => {
      script({}, [stored({})]);
      await updateReview(3, { publish_apps: true, credit: 'dj_name' }, DJ);
      expect(mockInserts).toEqual([]);
      expect(mockWrites.updated).toMatchObject({ publish_apps: true, credit: 'dj_name' });
    });

    test('a patch that sends the stored values writes none', async () => {
      script({ fcc: 'same' }, [stored({})]);
      await updateReview(3, { review: 'kept', fcc: 'same' }, DJ);
      expect(mockInserts).toEqual([]);
    });

    test('a consent field in the same patch as a content change still writes one revision', async () => {
      script({}, editor, [{ n: 1 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
      mockUpdatedRow = stored({ fcc: 'x' });
      await updateReview(3, { fcc: 'x', credit: 'none' }, DJ);
      expect(mockInserts).toHaveLength(1);
    });

    test('the first edit of a submitted review with no history writes revision 1 (the content before the edit, the author, at submitted_at), then revision 2', async () => {
      script({ review: 'before' }, editor, [{ n: 0 }], [{ id: 3 }], [{ n: 0 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
      mockUpdatedRow = stored({ review: 'after' });
      await updateReview(3, { review: 'after' }, MD);
      expect(mockInserts.map((i) => i.table)).toEqual(['review_revisions', 'review_revisions']);
      expect(mockInserts[0].values).toEqual({
        review_id: 3,
        revision: 1,
        review: 'before',
        artist_blurb: null,
        buzzwords: null,
        recommended_tracks: null,
        fcc: null,
        edited_by: 'Cat Power Fan',
        edited_by_user_id: 'dj-1',
        edited_at: new Date('2026-09-30T12:00:00.000Z'),
      });
      expect(mockInserts[1].values).toMatchObject({
        revision: 2,
        review: 'after',
        edited_by: 'Test Reviewer',
        edited_by_user_id: 'md-1',
      });
      // Revision 1 is the pre-edit content, so it is written before the UPDATE.
      expect(mockStatements.indexOf('insert review_revisions')).toBeLessThan(mockStatements.indexOf('update'));
      expect(mockStatements.lastIndexOf('insert review_revisions')).toBeGreaterThan(mockStatements.indexOf('update'));
    });

    test('a submitted review with no history and no submitted_at (status from the column default) stamps revision 1 at last_modified, not at this edit', async () => {
      script(
        { submitted_at: null },
        editor,
        [{ n: 0 }],
        [{ id: 3 }],
        [{ n: 0 }],
        [{ id: 3 }],
        [{ n: 1 }],
        [stored({})]
      );
      mockUpdatedRow = stored({ review: 'after' });
      await updateReview(3, { review: 'after' }, MD);
      expect(mockInserts[0].values).toMatchObject({ revision: 1, edited_at: new Date('2026-09-30T12:30:00.000Z') });
      expect(mockInserts[1].values).not.toHaveProperty('edited_at');
    });
  });

  describe('consent belongs to the author', () => {
    test.each([
      { credit: 'dj_name' },
      { credit: null },
      { publish_website: true },
      { publish_apps: false },
      { publish_instagram: true },
    ])(
      "a music director's patch carrying %j on someone else's review is consent_forbidden and writes nothing",
      async (patch) => {
        script({});
        expect(await updateReview(3, patch, MD)).toEqual({ outcome: 'consent_forbidden' });
        expect(mockWrites.updated).toBeUndefined();
        expect(mockInserts).toEqual([]);
      }
    );

    test("another DJ's consent patch is the plain forbidden: they may not edit the review at all", async () => {
      script({});
      expect(await updateReview(3, { credit: 'dj_name' }, { id: 'dj-2', manage: false })).toEqual({
        outcome: 'forbidden',
      });
      expect(mockWrites.updated).toBeUndefined();
    });

    test("a music director's patch of a review's text succeeds", async () => {
      script({}, [{ name: 'Test MD' }], [{ n: 1 }], [{ id: 3 }], [{ n: 1 }], [stored({})]);
      mockUpdatedRow = stored({ review: 'fixed' });
      expect((await updateReview(3, { review: 'fixed' }, MD)).outcome).toBe('updated');
    });

    test('the linked author of an on-behalf review sets their own consent', async () => {
      script({ author_user_id: 'dj-1', recorded_by_user_id: 'md-1' }, [stored({})]);
      expect((await updateReview(3, { credit: 'real_name', publish_website: true }, DJ)).outcome).toBe('updated');
      expect(mockWrites.updated).toMatchObject({ credit: 'real_name', publish_website: true });
    });
  });
});
