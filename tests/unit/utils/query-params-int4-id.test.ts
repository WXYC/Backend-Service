import { parseInt4PathId } from '../../../apps/backend/utils/query-params';

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
