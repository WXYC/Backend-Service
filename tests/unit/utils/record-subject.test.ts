import { parseRecordSubject } from '../../../apps/backend/utils/record-subject';

describe('parseRecordSubject', () => {
  test.each([
    ['an intake item only', { intake_item_id: 4 }, { intake_item_id: 4 }],
    ['a release only', { album_id: 9 }, { album_id: 9 }],
  ])('accepts %s', (_name, body, expected) => {
    expect(parseRecordSubject(body)).toEqual(expected);
  });

  test.each([
    ['both', { intake_item_id: 4, album_id: 9 }, 'Send exactly one of intake_item_id and album_id'],
    ['neither', {}, 'Send exactly one of intake_item_id and album_id'],
    ['a malformed item id', { intake_item_id: '4' }, 'intake_item_id must be a positive integer'],
    ['a malformed release id', { album_id: 0 }, 'album_id must be a positive integer'],
  ])('rejects %s with a 400', (_name, body, message) => {
    expect(() => parseRecordSubject(body)).toThrow(expect.objectContaining({ message, statusCode: 400 }));
  });
});
