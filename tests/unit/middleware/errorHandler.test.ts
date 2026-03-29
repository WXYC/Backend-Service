import errorHandler from '../../../apps/backend/middleware/errorHandler';
import WxycError from '../../../apps/backend/utils/error';
import { Request, Response, NextFunction } from 'express';

function mockResponse() {
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = {
    status: statusMock,
    json: jsonMock,
  } as unknown as Response;
  return { res, statusMock, jsonMock };
}

const mockReq = {} as Request;
const mockNext = jest.fn() as NextFunction;

describe('errorHandler middleware', () => {
  it('returns { message } with correct status for WxycError', () => {
    const { res, statusMock, jsonMock } = mockResponse();
    const error = new WxycError('Album not found', 404);

    errorHandler(error, mockReq, res, mockNext);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'Album not found' });
  });

  it('returns generic message for non-WxycError (does not leak internals)', () => {
    const { res, statusMock, jsonMock } = mockResponse();
    const error = new Error('SELECT * FROM users failed: connection refused');

    errorHandler(error, mockReq, res, mockNext);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'Internal server error' });
  });

  it('handles non-Error values thrown', () => {
    const { res, statusMock, jsonMock } = mockResponse();

    errorHandler('something broke', mockReq, res, mockNext);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'Internal server error' });
  });

  it('logs non-WxycError errors to console', () => {
    const { res } = mockResponse();
    const error = new Error('db connection lost');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    errorHandler(error, mockReq, res, mockNext);

    expect(consoleSpy).toHaveBeenCalledWith('Unhandled error:', error);
    consoleSpy.mockRestore();
  });
});
