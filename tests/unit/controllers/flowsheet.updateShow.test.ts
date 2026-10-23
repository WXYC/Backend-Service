/**
 * `PATCH /flowsheet/shows/:id` (BS#3456): tag or correct an existing show's specialty program and title. The real
 * service runs against a faked `db`; every read (the show, its newest row, its DJs, the catalog check, the response
 * projection) is answered in the order the code issues them, so each case lists only the reads it reaches.
 */
import { jest } from '@jest/globals';
import type { Response } from 'express';
import { db } from '@wxyc/database';

const mockBroadcast = jest.fn();
jest.mock('../../../apps/backend/utils/serverEvents', () => ({
  Topics: { liveFs: 'live-fs-topic' },
  FsEvents: { refetch: 'refetch' },
  serverEventsMgr: { broadcast: mockBroadcast },
}));

import { updateShow } from '../../../apps/backend/controllers/flowsheet.controller';
import WxycError from '../../../apps/backend/utils/error';

const DJ = 'dj-caller';
const START = new Date('2026-10-17T22:00:00Z');
const PROGRAM = { id: 7, specialty_name: 'Sonic Boom', slug: 'sonic-boom', short_name: 'Boom', logs_playcuts: true };

const OPEN_SHOW = [{ end_time: null, specialty_id: null }];
const OPEN_MEMBER = [OPEN_SHOW, [{ entry_type: 'track' }], [{ dj_id: DJ }], [{ id: DJ }]];
const ENDED_SHOW = [[{ end_time: new Date('2026-10-17T23:00:00Z'), specialty_id: null }]];
const TAGGABLE = [{ id: 7 }];
const rangeRow = (over: Record<string, unknown>) => [
  {
    id: 5,
    show_name: null,
    specialty_id: null,
    specialty: null,
    start_time: START,
    end_time: null,
    dj_name_override: null,
    legacy_dj_name: null,
    primary_dj_id: DJ,
    user_id: DJ,
    user_dj_name: 'dj sue',
    ...over,
  },
];

const makeDb = (reads: unknown[][]) => {
  const queue = [...reads];
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'for', 'limit', 'orderBy', 'leftJoin']) {
      c[m] = jest.fn().mockReturnValue(c);
    }
    c.then = (resolve: (v: unknown) => void) => resolve(rows);
    return c;
  };
  const set = jest.fn().mockReturnValue({ where: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) });
  const handle = {
    select: jest.fn().mockImplementation(() => chain(queue.shift() ?? [])),
    update: jest.fn(() => ({ set })),
  };
  (db as any).select = handle.select;
  (db as any).transaction = jest
    .fn()
    .mockImplementation(async (cb: (t: typeof handle) => Promise<unknown>) => cb(handle));
  return { ...handle, set };
};

const call = (body: unknown, { manage = false, id = '5' } = {}) => {
  const req = {
    params: { id },
    body,
    auth: { id: DJ, role: manage ? 'musicDirector' : 'dj' },
  } as unknown as Parameters<typeof updateShow>[0];
  const res = {
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { res, outcome: updateShow(req, res, jest.fn()) };
};

describe('PATCH /flowsheet/shows/:id (BS#3456)', () => {
  beforeEach(() => jest.clearAllMocks());

  type SuccessCase = [
    string,
    Record<string, unknown>,
    unknown[][],
    boolean,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  const successes: SuccessCase[] = [
    [
      'tags an open show as a member',
      { specialty_id: 7 },
      [...OPEN_MEMBER, TAGGABLE, rangeRow({ specialty_id: 7, specialty: PROGRAM })],
      false,
      { specialty_id: 7 },
      { specialty_id: 7, specialty: expect.objectContaining({ id: 7, name: 'Sonic Boom' }) },
    ],
    [
      'clears the tag with null',
      { specialty_id: null },
      [...OPEN_MEMBER, rangeRow({})],
      false,
      { specialty_id: null },
      { specialty_id: null, specialty: null },
    ],
    [
      'sets only show_name',
      { show_name: 'Boom Hour' },
      [...OPEN_MEMBER, rangeRow({ show_name: 'Boom Hour' })],
      false,
      { show_name: 'Boom Hour' },
      { show_name: 'Boom Hour' },
    ],
    [
      'trims show_name and stores blank as null',
      { show_name: '   ' },
      [...OPEN_MEMBER, rangeRow({})],
      false,
      { show_name: null },
      { show_name: null },
    ],
    [
      'accepts the current, since-retired id',
      { specialty_id: 7 },
      [
        [{ end_time: null, specialty_id: 7 }],
        [{ entry_type: 'track' }],
        [{ dj_id: DJ }],
        [{ id: DJ }],
        rangeRow({ specialty_id: 7, specialty: PROGRAM }),
      ],
      false,
      { specialty_id: 7 },
      { specialty_id: 7 },
    ],
    ...(['requests', 'feedback', 'closed', null] as const).map(
      (mode) =>
        [
          `sets request_mode to ${mode}`,
          { request_mode: mode },
          [...OPEN_MEMBER, rangeRow({})],
          false,
          { request_mode: mode },
          {},
        ] as SuccessCase
    ),
    [
      'lets a manager edit an ended show',
      { show_name: 'Fixed' },
      [...ENDED_SHOW, rangeRow({ show_name: 'Fixed', end_time: START })],
      true,
      { show_name: 'Fixed' },
      { show_name: 'Fixed' },
    ],
  ];

  test.each(successes)('%s', async (_name, body, reads, manage, written, projected) => {
    const handle = makeDb(reads);
    const { res, outcome } = call(body, { manage });
    await outcome;

    expect(handle.set).toHaveBeenCalledWith(written);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 5, ...projected }));
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'show-transition' },
    });
  });

  const failures: Array<[string, unknown, unknown[][], number, string | undefined]> = [
    ['an unknown specialty id', { specialty_id: 99 }, [...OPEN_MEMBER, []], 400, 'specialty_not_taggable'],
    [
      'a retired id that is not the current value',
      { specialty_id: 8 },
      [[{ end_time: null, specialty_id: 7 }], [{ entry_type: 'track' }], [{ dj_id: DJ }], [{ id: DJ }], []],
      400,
      'specialty_not_taggable',
    ],
    ['a non-integer specialty id', { specialty_id: '7' }, [...OPEN_MEMBER], 400, undefined],
    ['a title over 128 characters', { show_name: 'x'.repeat(129) }, [], 400, undefined],
    ['an unknown request_mode', { request_mode: 'loud' }, [...OPEN_MEMBER], 400, undefined],
    ['a request_mode that is not a string', { request_mode: 5 }, [...OPEN_MEMBER], 400, undefined],
    ['a title that is not a string', { show_name: 5 }, [], 400, undefined],
    [
      'a non-member on an open show',
      { show_name: 'Mine' },
      [OPEN_SHOW, [{ entry_type: 'track' }], [{ dj_id: 'other' }], [{ id: 'other' }]],
      400,
      undefined,
    ],
    [
      'a non-manager on a show whose newest row is show_end and whose end_time is still null',
      { show_name: 'Mine' },
      [[{ end_time: null, specialty_id: null }], [{ entry_type: 'show_end' }]],
      403,
      'closed_show',
    ],
    ['a non-manager on an ended show', { show_name: 'Mine' }, [...ENDED_SHOW], 403, 'closed_show'],
    ['an unknown show', { show_name: 'Mine' }, [[]], 404, undefined],
    ['a show id that is not a positive integer', { show_name: 'Mine' }, [], 400, undefined],
  ];

  test.each(failures)(
    'rejects %s, writes nothing and does not broadcast',
    async (name, body, reads, statusCode, code) => {
      const handle = makeDb(reads);
      const { outcome } = call(body, { id: name.startsWith('a show id') ? 'abc' : '5' });

      await expect(outcome).rejects.toBeInstanceOf(WxycError);
      await expect(outcome).rejects.toMatchObject({ statusCode, code });
      expect(handle.update).not.toHaveBeenCalled();
      expect(mockBroadcast).not.toHaveBeenCalled();
    }
  );
});
