import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockParseOnly = jest.fn<() => Promise<Record<string, unknown>>>();

jest.mock('../../../apps/backend/services/requestLine/index', () => ({
  parseOnly: mockParseOnly,
  getConfig: jest.fn(),
  isParsingEnabled: jest.fn(),
  processRequest: jest.fn(),
}));

jest.mock('../../../apps/backend/services/requestLine.service', () => ({}));
jest.mock('../../../apps/backend/services/anonymousDevice.service', () => ({}));
jest.mock('../../../apps/backend/services/library.service', () => ({}));

import { parseMessage } from '../../../apps/backend/controllers/requestLine.controller';

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
};

describe('parseMessage', () => {
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn();
  });

  it('returns parsed result on success', async () => {
    const parsed = { isRequest: true, artist: 'Autechre', album: 'Confield' };
    mockParseOnly.mockResolvedValue(parsed);

    const req = { body: { message: 'play Autechre' }, method: 'POST', originalUrl: '/request/parse', ip: '127.0.0.1' } as unknown as Request;
    const res = createMockRes();

    await parseMessage(req, res as Response, mockNext as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, parsed });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('calls next(error) when parseOnly throws', async () => {
    const error = new Error('AI service unavailable');
    mockParseOnly.mockRejectedValue(error);

    const req = { body: { message: 'play something' }, method: 'POST', originalUrl: '/request/parse', ip: '127.0.0.1' } as unknown as Request;
    const res = createMockRes();

    await parseMessage(req, res as Response, mockNext as unknown as NextFunction);

    expect(mockNext).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 400 when message is missing', async () => {
    const req = { body: {}, method: 'POST', originalUrl: '/request/parse', ip: '127.0.0.1' } as unknown as Request;
    const res = createMockRes();

    await parseMessage(req, res as Response, mockNext as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockParseOnly).not.toHaveBeenCalled();
  });
});
