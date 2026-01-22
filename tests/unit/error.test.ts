/**
 * Unit tests for WxycError class
 */

import WxycError from '../../apps/backend/utils/error';

describe('WxycError', () => {
  describe('constructor', () => {
    it('should create error with message only (default status 500)', () => {
      const error = new WxycError('Something went wrong');

      expect(error.message).toBe('Something went wrong');
      expect(error.statusCode).toBe(500);
      expect(error.name).toBe('WxycError');
    });

    it('should create error with custom status code', () => {
      const error = new WxycError('Not found', 404);

      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('WxycError');
    });

    it('should create error with custom name', () => {
      const error = new WxycError('Validation failed', 400, 'ValidationError');

      expect(error.message).toBe('Validation failed');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('ValidationError');
    });

    it('should create error with all custom values', () => {
      const error = new WxycError('Unauthorized access', 401, 'AuthError');

      expect(error.message).toBe('Unauthorized access');
      expect(error.statusCode).toBe(401);
      expect(error.name).toBe('AuthError');
    });
  });

  describe('inheritance', () => {
    it('should be an instance of Error', () => {
      const error = new WxycError('Test error');

      expect(error).toBeInstanceOf(Error);
    });

    it('should be an instance of WxycError', () => {
      const error = new WxycError('Test error');

      expect(error).toBeInstanceOf(WxycError);
    });

    it('should have a stack trace', () => {
      const error = new WxycError('Test error');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('WxycError');
    });
  });

  describe('common HTTP status codes', () => {
    const testCases = [
      { status: 400, name: 'Bad Request' },
      { status: 401, name: 'Unauthorized' },
      { status: 403, name: 'Forbidden' },
      { status: 404, name: 'Not Found' },
      { status: 409, name: 'Conflict' },
      { status: 422, name: 'Unprocessable Entity' },
      { status: 429, name: 'Too Many Requests' },
      { status: 500, name: 'Internal Server Error' },
      { status: 502, name: 'Bad Gateway' },
      { status: 503, name: 'Service Unavailable' },
    ];

    testCases.forEach(({ status, name }) => {
      it(`should handle ${status} ${name}`, () => {
        const error = new WxycError(`${name} error`, status);

        expect(error.statusCode).toBe(status);
        expect(error.message).toBe(`${name} error`);
      });
    });
  });

  describe('error throwing and catching', () => {
    it('should be throwable', () => {
      expect(() => {
        throw new WxycError('Test throw');
      }).toThrow(WxycError);
    });

    it('should be catchable with status code preserved', () => {
      try {
        throw new WxycError('Caught error', 418);
      } catch (error) {
        if (error instanceof WxycError) {
          expect(error.statusCode).toBe(418);
          expect(error.message).toBe('Caught error');
        } else {
          fail('Error should be instance of WxycError');
        }
      }
    });
  });
});
