/**
 * The music-director notices (BS#2806): the assigned line's four cases are pure and pinned as a table;
 * recipients, one-email-per-director and swallow-on-failure run against a scripted fake `db` and a mocked
 * sender, so no test reaches SES.
 */
jest.unmock('drizzle-orm');

// An `Error` entry makes that query reject; an array entry resolves to those rows.
const mockQueue: (unknown[] | Error)[] = [];
const mockSend = jest.fn<(email: unknown) => Promise<void>>();
const mockCapture = jest.fn();

jest.mock('@sentry/node', () => ({ captureException: (...args: unknown[]) => mockCapture(...args) }));
jest.mock('@wxyc/authentication', () => ({
  ...jest.requireActual('../../../shared/authentication/src/auth.roles'),
  ...jest.requireActual('../../../shared/authentication/src/ban-in-force'),
  sendNotificationEmail: (email: unknown) => mockSend(email),
}));
jest.mock('@wxyc/database', () => {
  const chain: any = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where']) chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) => {
    const next = mockQueue.shift() ?? [];
    return next instanceof Error ? reject(next) : resolve(next);
  };
  return { ...jest.requireActual('../../../shared/database/src/schema'), db: { select: () => chain } };
});
jest.mock('../../../apps/backend/services/intake.service', () => ({
  effectiveState: jest.requireActual('drizzle-orm').sql`effective_state`,
}));

import { db } from '@wxyc/database';
import {
  assignedLine,
  musicDirectorEmails,
  notifyFccNoteReported,
  notifyPass,
  notifyReviewSubmitted,
  readReviewNotice,
  type AssignedLine,
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
    { role: 'musicDirector', email: 'md-one@example.org', banned: false, banExpires: null },
    { role: 'musicDirector', email: 'md-two@example.org', banned: null, banExpires: null },
    { role: 'stationManager', email: 'manager@example.org', banned: false, banExpires: null },
    { role: 'dj', email: 'dj@example.org', banned: false, banExpires: null },
  ];
  const URL = 'https://dj.example.org/dashboard/admin/intake/4';
  const LINK = `<p><a href="${URL}">Open in the Pile</a></p>`;
  type Sent = { to: string[]; subject: string; text: string; html: string };
  const sent = (n = 0) => mockSend.mock.calls.at(n)![0] as Sent;
  const savedFrontend = process.env.FRONTEND_SOURCE;
  beforeEach(() => {
    process.env.FRONTEND_SOURCE = 'https://dj.example.org, http://localhost:3000';
    mockQueue.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue(undefined);
    mockCapture.mockReset();
  });
  afterAll(() => {
    if (savedFrontend === undefined) delete process.env.FRONTEND_SOURCE;
    else process.env.FRONTEND_SOURCE = savedFrontend;
  });

  test('a submit sends one email per music director and none to a station manager or DJ', async () => {
    mockQueue.push(DIRECTORS);
    await notifyReviewSubmitted(NOTICE);
    expect(mockSend.mock.calls.map(([e]) => (e as Sent).to)).toEqual([['md-one@example.org'], ['md-two@example.org']]);
  });

  // The station's copy of 2026-10-06 (BS#2806), pinned whole: subject, plain text (the sentences on separate
  // lines, then the full URL) and HTML (the same sentences, then the link). `{artist} – {album}` is an en dash.
  test.each([
    [
      'from the holder',
      NOTICE.author,
      { kind: 'holder' },
      'A review of Juana Molina – DOGA by Test Reviewer is waiting to be accepted.',
      'This review is from the DJ who has the record.',
    ],
    [
      'from another DJ, while a named DJ has the record',
      NOTICE.author,
      { kind: 'other_dj', holderName: 'Test Holder' },
      'A review of Juana Molina – DOGA by Test Reviewer is waiting to be accepted.',
      'This review is from another DJ; the record is with Test Holder.',
    ],
    [
      "from another DJ, while the holder's name is null",
      NOTICE.author,
      { kind: 'other_dj', holderName: null },
      'A review of Juana Molina – DOGA by Test Reviewer is waiting to be accepted.',
      'This review is from another DJ; the record is checked out to a different DJ.',
    ],
    [
      'from another DJ, while the holder was removed',
      NOTICE.author,
      { kind: 'removed_holder' },
      'A review of Juana Molina – DOGA by Test Reviewer is waiting to be accepted.',
      "This review is from another DJ; the record is checked out and its holder's account was removed.",
    ],
    [
      'from another DJ, while nobody has the record',
      NOTICE.author,
      { kind: 'pool' },
      'A review of Juana Molina – DOGA by Test Reviewer is waiting to be accepted.',
      'This review is from another DJ; nobody has the record checked out.',
    ],
    [
      'with a null author snapshot',
      null,
      { kind: 'pool' },
      'A review of Juana Molina – DOGA by a DJ is waiting to be accepted.',
      'This review is from another DJ; nobody has the record checked out.',
    ],
  ] as const)('the submit email, %s, is the decided copy', async (_name, author, line, first, second) => {
    mockQueue.push(DIRECTORS);
    await notifyReviewSubmitted({ ...NOTICE, author, line });
    expect(sent()).toEqual({
      to: ['md-one@example.org'],
      subject: 'Review waiting to be accepted: Juana Molina – DOGA',
      text: `${first}\n${second}\n${URL}`,
      html: `<p>${first}</p><p>${second.replace("'", '&#39;')}</p>${LINK}`,
    });
  });

  test.each([
    ['the display name', [{ name: 'Test DJ' }], 'Test DJ'],
    ['"A DJ" when the name is null', [{ name: null }], 'A DJ'],
    ['"A DJ" when the account has no name to read', [], 'A DJ'],
  ])('the pass email names the DJ by %s, in the decided copy', async (_name, account, dj) => {
    mockQueue.push(account, DIRECTORS);
    await notifyPass({ id: 4, artist: 'Juana Molina', album: 'DOGA' }, 'dj-1');
    const body = `${dj} passed on the request for Juana Molina – DOGA. Any DJ can take it now.`;
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual({
      to: ['md-two@example.org'],
      subject: 'Request passed: Juana Molina – DOGA',
      text: `${body}\n${URL}`,
      html: `<p>${body}</p>${LINK}`,
    });
  });

  // The FCC-note email's copy, decided by the station on 2026-10-06 (BS#2863), pinned byte for byte: the subject, both
  // lines (`{artist} – {album}` joined by an en dash), and the link's path and text.
  describe('the FCC-note notice', () => {
    const FCC: Parameters<typeof notifyFccNoteReported>[0] = {
      note: {
        id: 5,
        track: 'la paradoja',
        note: 'A placeholder note.',
        reported_by: 'Test Reporter',
      } as Parameters<typeof notifyFccNoteReported>[0]['note'],
      artist: 'Juana Molina',
      album: 'DOGA',
      reporterUserId: 'dj-1',
    };
    const FCC_URL = 'https://dj.example.org/dashboard/admin/intake';

    test('is the decided copy', async () => {
      mockQueue.push(DIRECTORS);
      await notifyFccNoteReported(FCC);
      const first = 'Test Reporter reported an FCC note on Juana Molina – DOGA.';
      const second = 'la paradoja: A placeholder note.';
      expect(sent()).toEqual({
        to: ['md-one@example.org'],
        subject: 'FCC note to confirm: Juana Molina – DOGA',
        text: `${first}\n${second}\n${FCC_URL}`,
        html: `<p>${first}</p><p>${second}</p><p><a href="${FCC_URL}">Open FCC notes to confirm</a></p>`,
      });
    });

    test('goes to every music director and to no one else', async () => {
      mockQueue.push(DIRECTORS);
      await notifyFccNoteReported(FCC);
      expect(mockSend.mock.calls.map(([e]) => (e as Sent).to)).toEqual([
        ['md-one@example.org'],
        ['md-two@example.org'],
      ]);
    });

    test('says neither "pool" nor "pile" and joins artist and album by an en dash', async () => {
      mockQueue.push(DIRECTORS);
      await notifyFccNoteReported(FCC);
      const { subject, text, html } = sent();
      for (const part of [subject, text, html]) {
        expect(part).not.toMatch(/pool|pile/i);
        expect(part).not.toContain('Juana Molina - DOGA');
      }
    });

    test('a failed send is reported under the note’s id and swallowed, and the other director is still sent to', async () => {
      mockQueue.push(DIRECTORS);
      mockSend.mockRejectedValueOnce(new Error('ses down'));
      jest.spyOn(console, 'error').mockImplementation(() => {});
      await expect(notifyFccNoteReported(FCC)).resolves.toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'ses down' }), {
        tags: { subsystem: 'review-notices' },
        extra: { fcc_note_id: 5 },
      });
      jest.restoreAllMocks();
    });
  });

  test('neither email says "pool", a lower-case "pile" or a hyphen between artist and album', async () => {
    const lines: AssignedLine[] = [
      { kind: 'holder' },
      { kind: 'other_dj', holderName: 'Test Holder' },
      { kind: 'other_dj', holderName: null },
      { kind: 'removed_holder' },
      { kind: 'pool' },
    ];
    for (const line of lines) {
      mockQueue.push(DIRECTORS);
      await notifyReviewSubmitted({ ...NOTICE, line });
    }
    mockQueue.push([{ name: 'Test DJ' }], DIRECTORS);
    await notifyPass({ id: 4, artist: 'Juana Molina', album: 'DOGA' }, 'dj-1');
    for (const [email] of mockSend.mock.calls) {
      const { subject, text, html } = email as Sent;
      for (const part of [subject, text, html]) {
        expect(part).not.toMatch(/pool/i);
        expect(part).not.toMatch(/\bpile\b/);
        expect(part).not.toContain('Juana Molina - DOGA');
      }
    }
  });

  test.each([
    ['a ban with no expiry', { banned: true, banExpires: null }, false],
    ['a ban that has not expired', { banned: true, banExpires: new Date(Date.now() + 86_400_000) }, false],
    ['a ban that has expired (lifted)', { banned: true, banExpires: new Date(Date.now() - 86_400_000) }, true],
    ['no ban', { banned: false, banExpires: null }, true],
  ])('a music director under %s is sent to: %s', async (_name, ban, expected) => {
    mockQueue.push([{ role: 'musicDirector', email: 'md-banned@example.org', ...ban }, DIRECTORS[0]]);
    expect(await musicDirectorEmails()).toEqual(
      expected ? ['md-banned@example.org', 'md-one@example.org'] : ['md-one@example.org']
    );
  });

  test('each submitted review of the same item sends again', async () => {
    mockQueue.push(DIRECTORS, DIRECTORS);
    await notifyReviewSubmitted(NOTICE);
    await notifyReviewSubmitted(NOTICE);
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  test('escapes author text in the HTML body', async () => {
    mockQueue.push(DIRECTORS);
    await notifyReviewSubmitted({ ...NOTICE, author: '<b>x</b>' });
    expect(sent().html).not.toContain('<b>x</b>');
  });

  test('a failed send is reported and swallowed, and the other directors are still sent to', async () => {
    mockQueue.push(DIRECTORS);
    mockSend.mockRejectedValueOnce(new Error('ses down'));
    await expect(notifyReviewSubmitted(NOTICE)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  test('the directors are sent to at once, not one after another', async () => {
    mockQueue.push(DIRECTORS);
    mockSend.mockReturnValueOnce(new Promise<void>(() => {}));
    void notifyReviewSubmitted(NOTICE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  // The controllers start a notice with `void` after the commit, so a notifier that rejected would be an unhandled
  // rejection, which Node turns into a process crash. These pin the two guards that keep that from happening.
  describe('a failed lookup never rejects out of a fire-and-forget notice', () => {
    const LOOKUP_FAILURES = [
      // `afterRead` is how many reads go through first; a rejection is queued, so the caller's push order covers it.
      ['rejects', (_afterRead: number) => void mockQueue.push(new Error('db down'))],
      [
        'throws synchronously',
        (afterRead: number) => {
          const real = db.select as (...args: unknown[]) => unknown;
          const spy = jest.spyOn(db, 'select');
          for (let i = 0; i < afterRead; i++) spy.mockImplementationOnce(() => real() as never);
          spy.mockImplementationOnce(() => {
            throw new Error('db down');
          });
        },
      ],
    ] as const;
    let consoleError: jest.SpyInstance;
    beforeEach(() => {
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const expectReported = () => {
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), {
        tags: { subsystem: 'review-notices' },
        extra: { item_id: 4 },
      });
      expect(mockSend).not.toHaveBeenCalled();
    };

    test.each(LOOKUP_FAILURES)(
      'the submit notice resolves, reports and sends nothing when the director lookup %s',
      async (_how, fail) => {
        fail(0);
        await expect(notifyReviewSubmitted(NOTICE)).resolves.toBeUndefined();
        expectReported();
      }
    );

    test.each(LOOKUP_FAILURES)(
      'the pass notice resolves, reports and sends nothing when the director lookup %s',
      async (_how, fail) => {
        mockQueue.push([{ name: 'Test DJ' }]);
        fail(1);
        await expect(notifyPass({ id: 4, artist: 'Juana Molina', album: 'DOGA' }, 'dj-1')).resolves.toBeUndefined();
        expectReported();
      }
    );

    test.each(LOOKUP_FAILURES)(
      'the pass notice resolves and still goes out, naming "A DJ", when the name lookup %s',
      async (_how, fail) => {
        fail(0);
        mockQueue.push(DIRECTORS);
        await expect(notifyPass({ id: 4, artist: 'Juana Molina', album: 'DOGA' }, 'dj-1')).resolves.toBeUndefined();
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(sent().text).toContain('A DJ passed on the request for Juana Molina – DOGA.');
        expect(mockCapture).not.toHaveBeenCalled();
      }
    );
  });
});
