/**
 * When `POST /intake` and `PATCH /intake/{id}` start the link lookup (BS#3391): after the commit, not awaited, for a new item and for
 * an edit that supplies a name, and not for an edit of anything else. The lookup itself is pinned in `intake-links.service.test.ts`.
 */
const mockLog = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockUpdate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockLookUp = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.mock('../../../apps/backend/services/intake.service', () => ({
  logIntakeItem: mockLog,
  updateIntakeItem: mockUpdate,
}));
jest.mock('../../../apps/backend/services/intake-links.service', () => ({ lookUpIntakeLinks: mockLookUp }));
jest.mock('../../../apps/backend/services/review-notices.service', () => ({}));
jest.mock('../../../apps/backend/services/review-print.service', () => ({ printIntakeItem: jest.fn() }));
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));
jest.mock('../../../apps/backend/utils/review-grants', () => ({}));

import type { Request, Response } from 'express';
import { logIntake, patchIntake } from '../../../apps/backend/controllers/intake.controller';

const ITEM = { id: 4, artist_name: 'Juana Molina', album_title: 'DOGA' };
const respond = () => ({ json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  mockLog.mockResolvedValue({ outcome: 'logged', item: ITEM });
  mockUpdate.mockResolvedValue({ outcome: 'updated', item: ITEM });
  mockLookUp.mockResolvedValue(undefined);
});

describe('the link lookup (BS#3391)', () => {
  test('a new item starts it, with the names kept', async () => {
    const res = respond();
    await logIntake({ body: { ...ITEM, format_id: 1 }, auth: { id: 'dj-1' } } as unknown as Request, res, jest.fn());
    expect(mockLookUp).toHaveBeenCalledWith(ITEM, false);
    expect(res.json).toHaveBeenCalledWith(ITEM);
  });

  test.each([
    ['an artist name', { artist_name: 'Cat Power' }],
    ['an album title', { album_title: 'Moon Pix' }],
  ])('an edit supplying %s starts it as a rename', async (_name, body) => {
    await patchIntake({ params: { id: '4' }, body } as unknown as Request<{ id: string }>, respond(), jest.fn());
    expect(mockLookUp).toHaveBeenCalledWith(ITEM, true);
  });

  test('an edit of other fields does not start it', async () => {
    await patchIntake(
      { params: { id: '4' }, body: { record_label: 'Sonamos' } } as unknown as Request<{ id: string }>,
      respond(),
      jest.fn()
    );
    expect(mockLookUp).not.toHaveBeenCalled();
  });

  test('a refused create or edit starts nothing', async () => {
    mockLog.mockResolvedValue({ outcome: 'unknown_reference' });
    await logIntake(
      { body: { ...ITEM, format_id: 1 }, auth: { id: 'dj-1' } } as unknown as Request,
      respond(),
      jest.fn()
    ).catch(() => {});
    mockUpdate.mockResolvedValue({ outcome: 'already_filed' });
    await patchIntake(
      { params: { id: '4' }, body: { artist_name: 'Cat Power' } } as unknown as Request<{ id: string }>,
      respond(),
      jest.fn()
    );
    expect(mockLookUp).not.toHaveBeenCalled();
  });

  test('a lookup that never settles does not hold the response', async () => {
    mockLookUp.mockReturnValue(new Promise<void>(() => {}));
    const res = respond();
    await logIntake({ body: { ...ITEM, format_id: 1 }, auth: { id: 'dj-1' } } as unknown as Request, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(ITEM);
  });
});
