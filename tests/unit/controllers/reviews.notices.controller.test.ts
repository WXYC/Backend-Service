/**
 * What `POST /reviews` and `PATCH /reviews/{id}` do with the notice data their service returns (BS#2864): each
 * notice is started after the transaction, never awaited, and a notice that fails never changes the response.
 */
const mockService = {
  updateReview: jest.fn<(...args: unknown[]) => unknown>(),
  recordReview: jest.fn<(...args: unknown[]) => unknown>(),
};
const mockNotify = {
  notifyReviewEdited: jest.fn<(n: unknown) => Promise<void>>(),
  notifyReviewRecorded: jest.fn<(n: unknown) => Promise<void>>(),
};

jest.mock('../../../apps/backend/services/reviews.service', () => ({ ...mockService, AUTHOR_MAX: 128 }));
jest.mock('../../../apps/backend/services/review-notices.service', () => ({
  ...mockNotify,
  notifyReviewSubmitted: jest.fn(),
}));
jest.mock('../../../apps/backend/utils/review-grants', () => ({ reviewsActor: () => ({ id: 'md-1', manage: true }) }));

import type { Request, Response } from 'express';
import { createReview, patchReview } from '../../../apps/backend/controllers/reviews.controller';

const respond = () => {
  const res = { json: jest.fn(), status: jest.fn() } as unknown as Response;
  return res;
};
const REVIEW = { id: 3 };
const NOTICE = { reviewId: 3 };

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockNotify)) fn.mockResolvedValue(undefined);
});

describe('PATCH /reviews/{id}', () => {
  const patch = (notices: object) => {
    mockService.updateReview.mockResolvedValue({ outcome: 'updated', review: REVIEW, ...notices });
    const res = respond();
    return patchReview(
      { params: { id: '3' }, body: { fcc: 'x' } } as unknown as Request<{ id: string }>,
      res,
      jest.fn()
    ).then(() => res);
  };

  test('starts notice 1 with the service data, and answers the review', async () => {
    const res = await patch({ authorNotice: NOTICE });
    expect(mockNotify.notifyReviewEdited).toHaveBeenCalledWith(NOTICE);
    expect(res.json).toHaveBeenCalledWith(REVIEW);
  });

  test('sends nothing when the service decided on no notice', async () => {
    const res = await patch({});
    expect(mockNotify.notifyReviewEdited).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(REVIEW);
  });

  test('a send that never settles does not hold the response', async () => {
    mockNotify.notifyReviewEdited.mockReturnValue(new Promise<void>(() => {}));
    const res = await patch({ authorNotice: NOTICE });
    expect(res.json).toHaveBeenCalledWith(REVIEW);
  });
});

describe('POST /reviews', () => {
  const create = async (result: object) => {
    mockService.recordReview.mockResolvedValue({ outcome: 'created', review: REVIEW, ...result });
    const res = respond();
    await createReview(
      { body: { intake_item_id: 4, author: 'Test Reviewer', author_user_id: 'dj-1' } } as unknown as Request,
      res,
      jest.fn()
    );
    return res;
  };

  test('starts notice 2 with the service data and answers the review', async () => {
    const res = await create({ notice: NOTICE });
    expect(mockNotify.notifyReviewRecorded).toHaveBeenCalledWith(NOTICE);
    expect(res.json).toHaveBeenCalledWith(REVIEW);
  });

  test('sends nothing without notice data', async () => {
    await create({ notice: undefined });
    expect(mockNotify.notifyReviewRecorded).not.toHaveBeenCalled();
  });

  test('a send that never settles does not hold the response', async () => {
    mockNotify.notifyReviewRecorded.mockReturnValue(new Promise<void>(() => {}));
    const res = await create({ notice: NOTICE });
    expect(res.json).toHaveBeenCalledWith(REVIEW);
  });
});
