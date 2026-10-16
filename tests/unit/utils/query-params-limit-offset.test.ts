import { parseLimitOffset } from '../../../apps/backend/utils/query-params';

describe('parseLimitOffset', () => {
  test.each([
    [undefined, undefined, { limit: undefined, offset: undefined }],
    ['1', '0', { limit: 1, offset: 0 }],
    ['50', '120', { limit: 50, offset: 120 }],
  ])('accepts limit=%j offset=%j', (limit, offset, expected) => {
    expect(parseLimitOffset(limit, offset, 50)).toEqual(expected);
  });

  test.each(['0', '51', 'abc', '4.5', '-1', ['5', '6']])('rejects limit=%j with the range 400', (limit) => {
    expect(() => parseLimitOffset(limit, undefined, 50)).toThrow(
      expect.objectContaining({
        message: 'Invalid Parameter: limit must be an integer between 1 and 50',
        statusCode: 400,
      })
    );
  });

  test.each(['abc', '-1', '1.5', ['1', '2']])('rejects offset=%j with the offset 400', (offset) => {
    expect(() => parseLimitOffset(undefined, offset, 50)).toThrow(
      expect.objectContaining({
        message: 'Invalid Parameter: offset must be a non-negative integer',
        statusCode: 400,
      })
    );
  });
});
