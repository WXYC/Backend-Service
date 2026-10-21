import { jest } from '@jest/globals';
import type { Request, Response } from 'express';

const mockSearchLibrary = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();

jest.mock('../../../apps/backend/services/requestLine/index', () => ({
  parseOnly: jest.fn(),
  getConfig: jest.fn(),
  isParsingEnabled: jest.fn(),
  processRequest: jest.fn(),
}));

jest.mock('../../../apps/backend/services/slack/index', () => ({
  postTextToSlack: jest.fn(),
}));
jest.mock('../../../apps/backend/services/library.service', () => ({
  searchLibrary: mockSearchLibrary,
}));

import { searchLibraryEndpoint } from '../../../apps/backend/controllers/requestLine.controller';

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
};

const createReq = (limit: unknown) =>
  ({
    query: { query: 'Stereolab', limit },
    method: 'GET',
    originalUrl: '/library/search',
    ip: '127.0.0.1',
  }) as unknown as Request;

describe('searchLibraryEndpoint limit parsing (BS#3587)', () => {
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn();
    mockSearchLibrary.mockResolvedValue([]);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    [undefined, 5],
    ['', 5],
    ['25', 25],
  ])('passes limit=%j to searchLibrary as %j', async (limit, expected) => {
    const res = createMockRes();

    await searchLibraryEndpoint(createReq(limit), res as Response, mockNext);

    expect(mockSearchLibrary).toHaveBeenCalledWith('Stereolab', undefined, undefined, expected);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test.each([
    ['abc', 'limit must be an integer from 1 to 2147483647'],
    ['0', 'limit must be an integer from 1 to 2147483647'],
    ['-3', 'limit must be an integer from 1 to 2147483647'],
    ['2.5', 'limit must be an integer from 1 to 2147483647'],
    ['7abc', 'limit must be an integer from 1 to 2147483647'],
    [['1', '2'], 'limit must be a single string value'],
  ])('rejects limit=%j with a 400', async (limit, message) => {
    const res = createMockRes();

    await expect(searchLibraryEndpoint(createReq(limit), res as Response, mockNext)).rejects.toMatchObject({
      message,
      statusCode: 400,
    });
    expect(mockSearchLibrary).not.toHaveBeenCalled();
  });
});
