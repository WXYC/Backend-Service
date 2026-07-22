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
   *
   * Echo requires TRUST, not just a 4xx number: upstream SDK errors
   * (groq-sdk APIError et al.) mirror the provider's HTTP status onto
   * `.status` and embed the raw provider body in `message` — echoing those
   * would leak provider/org/quota internals to unauthenticated-tier callers
   * and misreport our own dependency failures as the caller's 4xx. Trusted =
   * `expose: true` (the http-errors convention body-parser follows) or the
   * router's own percent-decode URIError. Everything else stays on the
   * generic-500 path.
   */
  describe('foreign errors carrying an HTTP status (express/router/body-parser convention)', () => {
    it('answers the carried 4xx status for a router percent-decode URIError (status, no statusCode)', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new URIError("Failed to decode param '%ZZ'"), { status: 400 });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({ message: "Failed to decode param '%ZZ'" });
    });

    it('answers a 4xx carried as statusCode when the error declares expose (http-errors, e.g. body-parser)', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      // Real body-parser shape: SyntaxError with status+statusCode+expose:true.
      const error = Object.assign(new Error('request entity too large'), { statusCode: 413, expose: true });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(413);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'request entity too large' });
    });

    it('parses a string-encoded 4xx status (express convention)', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(new Error('bad escape'), { status: '400', expose: true });

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'bad escape' });
    });

    // The groq-sdk APIError shape: integer `.status` mirroring the provider's
    // HTTP status, no `statusCode`, no `expose`, message embedding the raw
    // provider body. POST /request/parse rethrows these raw (parseOnly), so
    // without the trust gate an anonymous-session caller would receive the
    // provider's org/model/quota internals as a 429 — and Sentry would treat
    // it as client noise. It must stay a generic 500 (captured).
    it('does NOT echo an untrusted 4xx (no expose, not a URIError) — e.g. an upstream SDK error', () => {
      const { res, statusMock, jsonMock } = mockResponse();
      const error = Object.assign(
        new Error(
          '429 {"error":{"message":"Rate limit reached for model llama-3.3-70b-versatile in organization org_01abc"}}'
        ),
        { status: 429 }
      );

      errorHandler(error, mockReq, res, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ message: 'Internal server error' });
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
