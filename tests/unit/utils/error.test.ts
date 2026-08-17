import WxycError from '../../../apps/backend/utils/error';

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

  it('has a fixed name (subclasses override it after calling super)', () => {
    const error = new WxycError('Validation failed', 400);

    expect(error.message).toBe('Validation failed');
    expect(error.statusCode).toBe(400);
    expect(error.name).toBe('WxycError');
  });

  it('leaves code and details undefined when no opts are passed', () => {
    const error = new WxycError('Not found', 404);

    expect(error.code).toBeUndefined();
    expect(error.details).toBeUndefined();
  });

  it('carries a code when opts.code is passed', () => {
    const error = new WxycError('Artist code already in use', 409, { code: 'artist_code_conflict' });

    expect(error.code).toBe('artist_code_conflict');
    expect(error.details).toBeUndefined();
  });

  it('carries details alongside a code when both are passed', () => {
    const error = new WxycError('Artist code already in use', 409, {
      code: 'artist_code_conflict',
      details: { code_letters: 'ABC', code_number: 12 },
    });

    expect(error.code).toBe('artist_code_conflict');
    expect(error.details).toEqual({ code_letters: 'ABC', code_number: 12 });
  });

  it('carries details with no code when only opts.details is passed', () => {
    const error = new WxycError('Artist code already in use', 409, {
      details: { code_letters: 'ABC', code_number: 12 },
    });

    expect(error.code).toBeUndefined();
    expect(error.details).toEqual({ code_letters: 'ABC', code_number: 12 });
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
