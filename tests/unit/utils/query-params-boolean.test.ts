import { parseBooleanQueryParam } from '../../../apps/backend/utils/query-params';

describe('parseBooleanQueryParam', () => {
  test.each([
    [undefined, false],
    ['false', false],
    ['true', true],
  ])('accepts %j as %s', (raw, expected) => {
    expect(parseBooleanQueryParam(raw, 'mine')).toBe(expected);
  });

  test.each(['TRUE', '1', '', ['true', 'true']])('rejects %j with a 400 naming the field', (raw) => {
    expect(() => parseBooleanQueryParam(raw, 'mine')).toThrow(
      expect.objectContaining({ message: 'mine must be true or false', statusCode: 400 })
    );
  });
});
