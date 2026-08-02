import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import type { Show } from '@wxyc/database';

const mockGetLatestShow = jest.fn<() => Promise<Show | undefined>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
}));

import { activeShow } from '../../../apps/backend/middleware/checkActiveShow';

function createMockReqResNext() {
  const req = {} as Request;

  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = {
    status: statusMock,
    json: jsonMock,
  } as unknown as Response;

  const next = jest.fn() as unknown as NextFunction;

  return { req, res, next, statusMock, jsonMock };
}

describe('activeShow', () => {
  it('rejects when there is no latest show', async () => {
    mockGetLatestShow.mockResolvedValue(undefined);

    const { req, res, next, statusMock, jsonMock } = createMockReqResNext();

    await activeShow(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      message: 'Bad Request: No active show',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when the latest show has ended', async () => {
    mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() } as Show);

    const { req, res, next, statusMock } = createMockReqResNext();

    await activeShow(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows the request through when there is an active show', async () => {
    mockGetLatestShow.mockResolvedValue({ id: 1, end_time: null } as Show);

    const { req, res, next, statusMock } = createMockReqResNext();

    await activeShow(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });
});
