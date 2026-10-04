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
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        mockWrites.inserted = v;
        return { returning: () => Promise.resolve([{ id: 11 }]) };
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        mockWrites.updated = s;
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
  snapshotAuthor,
  updateReview,
} from '../../../apps/backend/services/reviews.service';
import { holdsReviewsManage } from '../../../apps/backend/utils/review-grants';

const DJ = { id: 'dj-1', manage: false };
const MD = { id: 'md-1', manage: true };

beforeEach(() => {
  mockQueue.length = 0;
  mockReads.length = 0;
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
    locked: false,
    ...o,
  });

  test.each([
    ['the author edits their draft', review({ status: 'draft' }), DJ, 'allowed'],
    ['the author edits a submitted review before print', review({}), DJ, 'allowed'],
    ['the author edits a submitted review after print: locked', review({ locked: true }), DJ, 'locked'],
    ['the author edits their draft on a printed item', review({ status: 'draft', locked: true }), DJ, 'allowed'],
    ['another DJ edits a submitted review', review({}), { id: 'dj-2', manage: false }, 'forbidden'],
    ['another DJ edits a draft: not visible', review({ status: 'draft' }), { id: 'dj-2', manage: false }, 'not_found'],
    ['a music director edits any submitted review', review({}), MD, 'allowed'],
    ['a music director edits a printed review', review({ locked: true }), MD, 'allowed'],
    // Draft privacy outranks manage: only the author and whoever recorded it may see a draft.
    ["a music director edits another user's draft: not visible", review({ status: 'draft' }), MD, 'not_found'],
    [
      'the recorder edits an on-behalf draft',
      review({ status: 'draft', author_user_id: null, recorded_by_user_id: 'md-1' }),
      MD,
      'allowed',
    ],
  ])('%s', (_name, r, actor, expected) => {
    expect(editOutcome(r, actor)).toBe(expected);
  });
});

describe('createReview', () => {
  const created = { id: 11, locked: false };

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

describe('updateReview', () => {
  const stored = (o: object) => ({
    id: 3,
    status: 'submitted',
    medium: 'typed',
    review: 'kept',
    author_user_id: 'dj-1',
    recorded_by_user_id: null,
    locked: false,
    ...o,
  });

  test('the edit is decided on locked rows inside one transaction: item FOR SHARE, then the review FOR UPDATE', async () => {
    mockQueue.push([{ item: 8 }], [{ id: 8 }], [{ id: 3 }], [stored({ intake_item_id: 8 })]);
    mockUpdatedRow = { id: 3 };
    await updateReview(3, { fcc: 'x' }, DJ);
    expect(mockReads.every((r) => r.handle === 'tx')).toBe(true);
    expect(mockReads.map((r) => [r.table, r.lock, r.of])).toEqual([
      ['reviews', undefined, undefined],
      ['intake_items', 'share', undefined],
      ['reviews', 'update', undefined],
      ['reviews', undefined, undefined],
    ]);
    expect(mockReads[1].where).toContain('[8]');
  });

  test('a review on a library release alone has no item to lock', async () => {
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored({})]);
    await updateReview(3, { fcc: 'x' }, DJ);
    expect(mockReads.map((r) => [r.table, r.lock])).toEqual([
      ['reviews', undefined],
      ['reviews', 'update'],
      ['reviews', undefined],
    ]);
  });

  test('the updated row comes from RETURNING with the locked value already read', async () => {
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored({ locked: false })]);
    mockUpdatedRow = { id: 3, fcc: 'x' };
    expect(await updateReview(3, { fcc: 'x' }, DJ)).toEqual({
      outcome: 'updated',
      review: { id: 3, fcc: 'x', locked: false },
    });
  });

  test('a missing review is not_found', async () => {
    mockQueue.push([]);
    expect(await updateReview(3, { fcc: 'x' }, DJ)).toEqual({ outcome: 'not_found' });
  });

  test('a lock after print refuses the author without writing', async () => {
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored({ locked: true })]);
    expect(await updateReview(3, { fcc: 'x' }, DJ)).toEqual({ outcome: 'locked' });
    expect(mockWrites.updated).toBeUndefined();
  });

  test('a patch that would null a submitted typed review text is text_required', async () => {
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored({})]);
    expect(await updateReview(3, { review: null }, DJ)).toEqual({ outcome: 'text_required' });
    expect(mockWrites.updated).toBeUndefined();
  });

  test.each([
    ['a draft', { status: 'draft' }],
    ['a submitted handwritten review', { medium: 'handwritten' }],
  ])('nulling the text of %s is allowed', async (_name, o) => {
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored(o)]);
    expect((await updateReview(3, { review: null }, DJ)).outcome).toBe('updated');
  });

  test('leaving review out of a patch keeps the stored text, so other fields still save', async () => {
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored({})]);
    expect((await updateReview(3, { fcc: 'x' }, DJ)).outcome).toBe('updated');
    expect(mockWrites.updated).toMatchObject({ fcc: 'x' });
  });

  test('a submitted typed review stays editable by its author while text remains', async () => {
    mockQueue.push([{ item: null }], [{ id: 3 }], [stored({})]);
    expect((await updateReview(3, { review: 'new' }, DJ)).outcome).toBe('updated');
  });
});
