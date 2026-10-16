import { parseBoundedInt, parseCodeQueryInt, parseRotationIdParam } from '../../../apps/backend/utils/query-params';

describe('parseBoundedInt', () => {
  test.each([
    [undefined, 24],
    ['1', 1],
    ['168', 168],
  ])('accepts %j', (raw, expected) => {
    expect(parseBoundedInt(raw, 'window_hours', 24, 168)).toBe(expected);
  });

  test.each([
    ['24h', 'Bad Request: window_hours must be a positive integer'],
    ['-1', 'Bad Request: window_hours must be a positive integer'],
    ['0', 'Bad Request: window_hours must be between 1 and 168'],
    ['169', 'Bad Request: window_hours must be between 1 and 168'],
  ])('rejects %j with its 400', (raw, message) => {
    expect(() => parseBoundedInt(raw, 'window_hours', 24, 168)).toThrow(
      expect.objectContaining({ message, statusCode: 400 })
    );
  });
});

describe('parseCodeQueryInt', () => {
  test.each([
    ['0', 0, 0],
    ['7', 1, 7],
    ['2147483647', 1, 2147483647],
  ])('accepts %j (min %d)', (raw, min, expected) => {
    expect(parseCodeQueryInt(raw, 'genre_id', min)).toBe(expected);
  });

  test.each([
    [undefined, 1, 'Missing query parameter: genre_id'],
    [['1', '2'] as unknown as string, 1, 'Invalid genre_id: must be a single value'],
    ['', 0, 'Invalid genre_id: must be an integer between 0 and 2147483647'],
    ['0', 1, 'Invalid genre_id: must be an integer between 1 and 2147483647'],
    ['2147483648', 1, 'Invalid genre_id: must be an integer between 1 and 2147483647'],
  ])('rejects %j with its 400', (raw, min, message) => {
    expect(() => parseCodeQueryInt(raw, 'genre_id', min)).toThrow(
      expect.objectContaining({ message, statusCode: 400 })
    );
  });
});

describe('parseRotationIdParam', () => {
  test.each([
    ['1', 1],
    ['42', 42],
    ['2147483647', 2147483647],
  ])('accepts %j', (raw, expected) => {
    expect(parseRotationIdParam(raw)).toBe(expected);
  });

  test.each([['0'], ['-1'], ['2147483648'], ['abc'], ['42abc'], [''], [' '], [undefined]])(
    'rejects %j with its 400',
    (raw) => {
      expect(() => parseRotationIdParam(raw)).toThrow(
        expect.objectContaining({ message: 'rotation_id must be a positive integer', statusCode: 400 })
      );
    }
  );
});
