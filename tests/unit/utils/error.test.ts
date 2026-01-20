import WxycError from '@/utils/error';

describe('WxycError', () => {
  it('creates error with default values', () => {
    const error = new WxycError('Something went wrong');

    expect(error.message).toBe('Something went wrong');
    expect(error.statusCode).toBe(500);
    expect(error.name).toBe('WxycError');
  });

  it('creates error with custom status code', () => {
    const error = new WxycError('Not found', 404);

    expect(error.message).toBe('Not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('WxycError');
  });

  it('creates error with custom name', () => {
    const error = new WxycError('Validation failed', 400, 'ValidationError');

    expect(error.message).toBe('Validation failed');
    expect(error.statusCode).toBe(400);
    expect(error.name).toBe('ValidationError');
  });

  it('extends Error class', () => {
    const error = new WxycError('Test error');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WxycError);
  });

  it('has stack trace', () => {
    const error = new WxycError('Test error');

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('WxycError');
  });

  it('handles common HTTP status codes', () => {
    const badRequest = new WxycError('Bad request', 400);
    const unauthorized = new WxycError('Unauthorized', 401);
    const forbidden = new WxycError('Forbidden', 403);
    const notFound = new WxycError('Not found', 404);
    const serverError = new WxycError('Internal server error', 500);

    expect(badRequest.statusCode).toBe(400);
    expect(unauthorized.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(notFound.statusCode).toBe(404);
    expect(serverError.statusCode).toBe(500);
  });
});
