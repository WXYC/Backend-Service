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

  // `details` with no `code` is deliberately in the matrix: both fields are
  // independently optional (ApiErrorResponse requires only `message`), so a
  // projection that gated on `code` alone would silently drop that payload on
  // the wire with no type error and no runtime warning.
  const DETAILS = { code_letters: 'ABC', code_number: 12 };
  it.each([
    ['no opts', undefined, undefined, undefined],
    ['code only', { code: 'artist_code_conflict' }, 'artist_code_conflict', undefined],
    ['code and details', { code: 'artist_code_conflict', details: DETAILS }, 'artist_code_conflict', DETAILS],
    ['details only', { details: DETAILS }, undefined, DETAILS],
  ])('carries %s onto code/details', (_label, opts, expectedCode, expectedDetails) => {
    const error = new WxycError('Artist code already in use', 409, opts);

    expect(error.code).toBe(expectedCode);
    expect(error.details).toEqual(expectedDetails);
  });

  // The projection is what the error handler puts on the wire. A bare error
  // must serialize to exactly `{ message }` — no `code`/`details` keys present
  // as undefined — or every existing 4xx body gains two keys.
  it.each([
    ['no opts', undefined, { message: 'Artist code already in use' }],
    [
      'code only',
      { code: 'artist_code_conflict' },
      { message: 'Artist code already in use', code: 'artist_code_conflict' },
    ],
    [
      'code and details',
      { code: 'artist_code_conflict', details: DETAILS },
      { message: 'Artist code already in use', code: 'artist_code_conflict', details: DETAILS },
    ],
    ['details only', { details: DETAILS }, { message: 'Artist code already in use', details: DETAILS }],
  ])('toApiErrorResponse emits the wire body for %s', (_label, opts, expected) => {
    const body = new WxycError('Artist code already in use', 409, opts).toApiErrorResponse();

    expect(body).toEqual(expected);
    expect(Object.keys(body).sort()).toEqual(Object.keys(expected).sort());
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
