import errorHandler from '../../../apps/backend/middleware/errorHandler';
import WxycError from '../../../apps/backend/utils/error';
import { LmlClientError } from '@wxyc/lml-client';
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

const mockReq = { method: 'GET', url: '/flowsheet/latest' } as Request;
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

  it('returns { message } with correct status for LmlClientError', () => {
    const { res, statusMock, jsonMock } = mockResponse();
    const error = new LmlClientError('LML request timed out', 504);

    errorHandler(error, mockReq, res, mockNext);

    expect(statusMock).toHaveBeenCalledWith(504);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'LML request timed out' });
  });

  it('logs non-WxycError errors to console', () => {
    const { res } = mockResponse();
    const error = new Error('db connection lost');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    errorHandler(error, mockReq, res, mockNext);

    expect(consoleSpy).toHaveBeenCalledWith('[GET /flowsheet/latest] Unhandled error:', error);
    consoleSpy.mockRestore();
  });

  /**
   * Express internals and standard middleware throw errors that carry a
   * numeric `status` (the router's percent-decode failure — URIError with
   * `status: 400` and NO `statusCode`) or an http-errors-style `statusCode`
   * (body-parser). Rendering those as 500s turns any malformed escape in a
   * public path segment (`GET /concerts/%ZZ` — BS#1694 made the first such
   * unauthenticated param route) into a probe-mintable fake internal error.
   * Only the 4xx band is trusted and echoed; foreign 5xx-status errors stay
   * on the generic-500 path so internals never leak.
   */
  describe('foreign errors carrying an HTTP status (express/router/body-parser convention)', () => {
    it('answers the carried 4xx status for a router percent-decode URIError (status, no statusCode)', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new URIError("Failed to decode param '%ZZ'"), { status: 400 });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({ message: "Failed to decode param '%ZZ'" });
    });

    it('answers a 4xx carried as statusCode (http-errors convention, e.g. body-parser)', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new Error('request entity too large'), { statusCode: 413 });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(413);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'request entity too large' });
    });

    it('parses a string-encoded 4xx status (express convention)', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new Error('bad escape'), { status: '400' });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'bad escape' });
    });

    it('keeps foreign 5xx-status errors on the generic 500 path (no internals leak)', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new Error('SELECT * FROM users failed'), { status: 503 });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'Internal server error' });
    });

    // Express 5's res.status() throws a RangeError on non-integer codes, so a
    // fractional carried status must fall through to the generic 500 instead
    // of detonating inside the error handler itself.
    it('ignores a non-integer carried status rather than passing it to res.status', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new Error('weird status'), { status: 404.5 });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'Internal server error' });
    });

    // `status` wins over `statusCode` when both are present — the SAME
    // precedence shouldCaptureExpressError uses (it imports the same helper),
    // so the response tier and the Sentry tier can never classify one error
    // divergently. With status=503 taking precedence, this error is a
    // generic 500 AND Sentry-captured; the sibling sentryErrorFilter test
    // pins the capture half.
    it('classifies a both-alias error by `status` first, matching the Sentry filter', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new Error('conflicted'), { statusCode: 404, status: 503 });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'Internal server error' });
    });

    it('logs the carried-status client error as a single line, not an unhandled dump', () => {
      const { res } = mockResponse();
      const error = Object.assign(new URIError("Failed to decode param '%2'"), { status: 400 });
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      errorHandler(error, mockReq, res, mockNext);

      expect(consoleSpy).toHaveBeenCalledWith("[GET /flowsheet/latest] URIError 400: Failed to decode param '%2'");
      consoleSpy.mockRestore();
    });
  });
});
