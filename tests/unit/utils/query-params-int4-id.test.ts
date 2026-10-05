import { parseInt4BodyId, parseInt4PathId, parseInt4QueryParam } from '../../../apps/backend/utils/query-params';

describe('parseInt4PathId', () => {
  test.each([
    ['1', 1],
    ['2147483647', 2147483647],
  ])('accepts %s', (raw, expected) => {
    expect(parseInt4PathId(raw, 'intake item')).toBe(expected);
  });

  // 2147483648 is a positive integer, so the message must not claim otherwise.
  test.each(['0', '-1', 'abc', '1.5', '', '2147483648', '99999999999999999999'])(
    'rejects %p with a neutral 400',
    (raw) => {
      expect(() => parseInt4PathId(raw, 'intake item')).toThrow(
        expect.objectContaining({ message: 'Invalid intake item id', statusCode: 400 })
      );
    }
  );
});

describe('parseInt4BodyId', () => {
  test.each<[string, unknown, boolean, unknown]>([
    ['undefined', undefined, false, undefined],
    ['undefined (nullable)', undefined, true, undefined],
    ['null (nullable)', null, true, null],
    ['1', 1, false, 1],
    ['2147483647', 2147483647, true, 2147483647],
  ])('accepts %s', (_label, value, nullable, expected) => {
    expect(parseInt4BodyId(value, 'format_id', { nullable })).toBe(expected);
  });

  test.each<[string, unknown, boolean, string]>([
    ['null', null, false, 'format_id must be a positive integer'],
    ['0', 0, false, 'format_id must be a positive integer'],
    ['-1', -1, true, 'format_id must be a positive integer or null'],
    ['2147483648', 2147483648, false, 'format_id must be a positive integer'],
    ['1.5', 1.5, true, 'format_id must be a positive integer or null'],
    ['"1"', '1', false, 'format_id must be a positive integer'],
    ['true', true, true, 'format_id must be a positive integer or null'],
  ])('rejects %s with a 400', (_label, value, nullable, message) => {
    expect(() => parseInt4BodyId(value, 'format_id', { nullable })).toThrow(
      expect.objectContaining({ message, statusCode: 400 })
    );
  });
});

describe('parseInt4QueryParam', () => {
  test.each<[unknown, number | undefined]>([
    [undefined, undefined],
    ['1', 1],
    ['2147483647', 2147483647],
  ])('accepts %p', (raw, expected) => {
    expect(parseInt4QueryParam(raw, 'album_id')).toBe(expected);
  });

  test.each<unknown>(['0', '2147483648', '1abc', '', ['1', '2']])('rejects %p with a 400', (raw) => {
    expect(() => parseInt4QueryParam(raw, 'album_id')).toThrow(
      expect.objectContaining({ message: 'album_id must be an integer from 1 to 2147483647', statusCode: 400 })
    );
  });
});
