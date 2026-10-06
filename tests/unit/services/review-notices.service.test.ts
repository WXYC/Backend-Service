/**
 * The music-director notices (BS#2806): the assigned line's four cases are pure and pinned as a table;
 * recipients, one-email-per-director and swallow-on-failure run against a scripted fake `db` and a mocked
 * sender, so no test reaches SES.
 */
jest.unmock('drizzle-orm');

const mockQueue: unknown[][] = [];
const mockSend = jest.fn<(email: unknown) => Promise<void>>();
const mockCapture = jest.fn();

jest.mock('@sentry/node', () => ({ captureException: (...args: unknown[]) => mockCapture(...args) }));
jest.mock('@wxyc/authentication', () => ({
  ...jest.requireActual('../../../shared/authentication/src/auth.roles'),
  sendNotificationEmail: (email: unknown) => mockSend(email),
}));
jest.mock('@wxyc/database', () => {
  const chain: any = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where']) chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => resolve(mockQueue.shift() ?? []);
  return { ...jest.requireActual('../../../shared/database/src/schema'), db: { select: () => chain } };
});
jest.mock('../../../apps/backend/services/intake.service', () => ({
  effectiveState: jest.requireActual('drizzle-orm').sql`effective_state`,
}));

import { db } from '@wxyc/database';
import {
  assignedLine,
  notifyPass,
  notifyReviewSubmitted,
  readReviewNotice,
  type NoticeItem,
  type ReviewNotice,
} from '../../../apps/backend/services/review-notices.service';

const AT = new Date('2026-10-01T12:00:00Z');
const ITEM = (over: Partial<NoticeItem>): NoticeItem => ({
  checked_out_at: null,
  checked_out_by: null,
  requested_dj_id: null,
  effective_state: 'pool',
  ...over,
});

describe('assignedLine', () => {
  test.each([
    [
      'checked out to the author',
      ITEM({ checked_out_at: AT, checked_out_by: 'dj-1', effective_state: 'checked_out' }),
      'dj-1',
      { kind: 'holder' },
    ],
    [
      'a live request of the author',
      ITEM({ requested_dj_id: 'dj-1', effective_state: 'requested' }),
      'dj-1',
      { kind: 'holder' },
    ],
    [
      'checked out to another DJ',
      ITEM({ checked_out_at: AT, checked_out_by: 'dj-2', effective_state: 'checked_out' }),
      'dj-1',
      { kind: 'other_dj', holderName: 'Test Holder' },
    ],
    [
      'a live request of another DJ',
      ITEM({ requested_dj_id: 'dj-2', effective_state: 'requested' }),
      'dj-1',
      { kind: 'other_dj', holderName: 'Test Holder' },
    ],
    [
      'checked out to a removed account',
      ITEM({ checked_out_at: AT, checked_out_by: null, effective_state: 'checked_out' }),
      'dj-1',
      { kind: 'removed_holder' },
    ],
    [
      'a removed holder and an author with no account',
      ITEM({ checked_out_at: AT, checked_out_by: null }),
      null,
      { kind: 'removed_holder' },
    ],
    ['the pool', ITEM({}), 'dj-1', { kind: 'pool' }],
    [
      'an expired request (reads as the pool)',
      ITEM({ requested_dj_id: 'dj-2', effective_state: 'pool' }),
      'dj-1',
      { kind: 'pool' },
    ],
    [
      'an author with no account, held by a DJ',
      ITEM({ checked_out_at: AT, checked_out_by: 'dj-2' }),
      null,
      { kind: 'other_dj', holderName: 'Test Holder' },
    ],
    [
      'a reviewed item that still has a checkout',
      ITEM({ checked_out_at: AT, checked_out_by: 'dj-1', effective_state: 'reviewed' }),
      'dj-1',
      { kind: 'holder' },
    ],
  ])('%s', (_name, item, author, expected) => {
    expect(assignedLine(item, author, 'Test Holder')).toEqual(expected);
  });
});

describe('readReviewNotice', () => {
  test('answers the item as read, with the line decided from its holder', async () => {
    mockQueue.push([
      {
        artist: 'Juana Molina',
        album: 'DOGA',
        checked_out_at: AT,
        checked_out_by: 'dj-2',
        requested_dj_id: null,
        effective_state: 'checked_out',
        holder_name: 'Test Holder',
      },
    ]);
    expect(await readReviewNotice(db, 4, { author: 'Test Reviewer', author_user_id: 'dj-1' })).toEqual({
      itemId: 4,
      artist: 'Juana Molina',
      album: 'DOGA',
      author: 'Test Reviewer',
      line: { kind: 'other_dj', holderName: 'Test Holder' },
    });
  });
});

describe('notices', () => {
  const NOTICE: ReviewNotice = {
    itemId: 4,
    artist: 'Juana Molina',
    album: 'DOGA',
    author: 'Test Reviewer',
    line: { kind: 'pool' },
  };
  const DIRECTORS = [
    { role: 'musicDirector', email: 'md-one@example.org' },
    { role: 'musicDirector', email: 'md-two@example.org' },
    { role: 'stationManager', email: 'manager@example.org' },
    { role: 'dj', email: 'dj@example.org' },
  ];
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue(undefined);
  });

  test('a submit sends one email per music director and none to a station manager or DJ', async () => {
    mockQueue.push(DIRECTORS);
    await notifyReviewSubmitted(NOTICE);
    expect(mockSend.mock.calls.map(([e]) => (e as { to: string[] }).to)).toEqual([
      ['md-one@example.org'],
      ['md-two@example.org'],
    ]);
    const sent = mockSend.mock.calls[0][0] as { subject: string; text: string; html: string };
    expect(sent.subject).toContain('Juana Molina - DOGA');
    expect(sent.text).toContain('Test Reviewer');
    expect(sent.text).toContain('nobody has the record');
    expect(sent.text).toContain('/dashboard/admin/intake/4');
  });

  test('each submitted review of the same item sends again', async () => {
    mockQueue.push(DIRECTORS, DIRECTORS);
    await notifyReviewSubmitted(NOTICE);
    await notifyReviewSubmitted(NOTICE);
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  test('a pass names the DJ by display name and sends one email per music director', async () => {
    mockQueue.push([{ name: 'Test DJ' }], DIRECTORS);
    await notifyPass({ id: 4, artist: 'Juana Molina', album: 'DOGA' }, 'dj-1');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect((mockSend.mock.calls[0][0] as { text: string }).text).toContain('Test DJ passed');
  });

  test('escapes author text in the HTML body', async () => {
    mockQueue.push(DIRECTORS);
    await notifyReviewSubmitted({ ...NOTICE, author: '<b>x</b>' });
    expect((mockSend.mock.calls[0][0] as { html: string }).html).not.toContain('<b>x</b>');
  });

  test('a failed send is logged and swallowed, and the other directors are still sent to', async () => {
    mockQueue.push(DIRECTORS);
    mockSend.mockRejectedValueOnce(new Error('ses down'));
    await expect(notifyReviewSubmitted(NOTICE)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
