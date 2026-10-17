/**
 * What `POST /intake/{id}/checkout` and `/accept` do about the digital-taken notice (BS#3102): it starts after the commit, is
 * never awaited, goes out only for a digital item that was taken, and names the taker so the music directors skip them. The
 * integration tier cannot see an email (`EMAIL_ENABLED=false`), so the decision is pinned here.
 */
const mockTransition = jest.fn<(...args: unknown[]) => unknown>();
const mockNotifyDigital = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockNotifyPass = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockNotifyAsked = jest.fn<(...args: unknown[]) => Promise<void>>();

const mockMemberAccount = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/intake.service', () => ({
  transitionIntakeItem: mockTransition,
  memberAccount: mockMemberAccount,
}));
jest.mock('../../../apps/backend/services/review-notices.service', () => ({
  notifyPass: mockNotifyPass,
  notifyAsked: mockNotifyAsked,
  notifyDigitalTaken: mockNotifyDigital,
}));
jest.mock('../../../apps/backend/services/review-print.service', () => ({ printIntakeItem: jest.fn() }));
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));
jest.mock('../../../apps/backend/utils/review-grants', () => ({
  reviewsActor: () => ({ id: 'dj-1', manage: false }),
  canBeAskedToReview: () => true,
}));

import type { Request, Response } from 'express';
import { acceptIntake, checkoutIntake, requestIntake } from '../../../apps/backend/controllers/intake.controller';

const item = (digital: boolean) => ({ artist_name: 'Juana Molina', album_title: 'DOGA', digital });
const respond = () => ({ json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) }) as unknown as Response;
const call = async (handler: typeof checkoutIntake, result: object) => {
  mockTransition.mockResolvedValue(result);
  const res = respond();
  await handler({ params: { id: '4' }, body: {} } as unknown as Request<{ id: string }>, res, jest.fn());
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNotifyDigital.mockResolvedValue(undefined);
  mockNotifyAsked.mockResolvedValue(undefined);
  mockMemberAccount.mockResolvedValue({ roles: ['dj'], username: 'test.dj' });
});

describe.each([
  ['checkout', checkoutIntake],
  ['accept', acceptIntake],
])('POST /intake/{id}/%s', (_action, handler) => {
  test('a digital item taken starts the notice with the taker, and answers the item', async () => {
    const res = await call(handler, { outcome: 'updated', item: item(true) });
    expect(mockNotifyDigital).toHaveBeenCalledWith({ id: 4, artist: 'Juana Molina', album: 'DOGA' }, 'dj-1');
    expect(res.json).toHaveBeenCalledWith(item(true));
  });

  test('a disc sends nothing', async () => {
    await call(handler, { outcome: 'updated', item: item(false) });
    expect(mockNotifyDigital).not.toHaveBeenCalled();
  });

  test.each(['state_changed', 'already_filed', 'forbidden'])(
    'a refused transition (%s) sends nothing',
    async (outcome) => {
      await call(handler, { outcome, item: item(true) }).catch(() => {});
      expect(mockNotifyDigital).not.toHaveBeenCalled();
    }
  );

  test('a send that never settles does not hold the response', async () => {
    mockNotifyDigital.mockReturnValue(new Promise<void>(() => {}));
    const res = await call(handler, { outcome: 'updated', item: item(true) });
    expect(res.json).toHaveBeenCalledWith(item(true));
  });
});

test.each([
  ['release', 'releaseIntake'],
  ['request', 'requestIntake'],
  ['cancel request', 'cancelIntakeRequest'],
  ['pass', 'passIntake'],
] as const)('%s never starts the digital notice, even for an updated digital item', async (_name, exported) => {
  const handlers = await import('../../../apps/backend/controllers/intake.controller');
  mockTransition.mockResolvedValue({ outcome: 'updated', item: item(true) });
  await handlers[exported](
    { params: { id: '4' }, body: { dj_id: 'dj-2' } } as unknown as Request<{ id: string }>,
    respond(),
    jest.fn()
  );
  expect(mockTransition).toHaveBeenCalledTimes(1);
  expect(mockNotifyDigital).not.toHaveBeenCalled();
});

// BS#3385: a request tells the asked DJ, after the commit and without holding the response; the audience gate is the notice's own.
describe('POST /intake/{id}/request', () => {
  const callRequest = async (result: object) => {
    mockTransition.mockResolvedValue(result);
    const res = respond();
    await requestIntake(
      { params: { id: '4' }, body: { dj_id: 'dj-2' } } as unknown as Request<{ id: string }>,
      res,
      jest.fn()
    );
    return res;
  };

  test('starts the asked notice with the asked DJ and the requester, and answers the item', async () => {
    const res = await callRequest({ outcome: 'updated', item: item(false) });
    expect(mockNotifyAsked).toHaveBeenCalledWith({ id: 4, artist: 'Juana Molina', album: 'DOGA' }, 'dj-2', 'dj-1');
    expect(res.json).toHaveBeenCalledWith(item(false));
  });

  test.each(['state_changed', 'already_filed', 'forbidden', 'not_found'])(
    'a refused request (%s) sends nothing',
    async (outcome) => {
      await callRequest({ outcome, item: item(false) }).catch(() => {});
      expect(mockNotifyAsked).not.toHaveBeenCalled();
    }
  );

  test('a send that never settles does not hold the response', async () => {
    mockNotifyAsked.mockReturnValue(new Promise<void>(() => {}));
    const res = await callRequest({ outcome: 'updated', item: item(false) });
    expect(res.json).toHaveBeenCalledWith(item(false));
  });
});
