import {
  codePointLength,
  isNonBlankString,
  validateTextField,
  normalizeOptionalText,
} from '../../../apps/backend/utils/text-fields';
import WxycError from '../../../apps/backend/utils/error';

const astral128 = '😀'.repeat(128);

describe('text-fields', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['😀', 1],
    [astral128, 128],
  ])('codePointLength(%j) is %i', (value, expected) => {
    expect(codePointLength(value)).toBe(expected);
  });

  it('counts an astral string over 128 UTF-16 units as 128 code points', () => {
    expect(astral128.length).toBeGreaterThan(128);
    expect(codePointLength(astral128)).toBe(128);
  });

  it.each([
    ['a', true],
    ['  a  ', true],
    ['', false],
    ['   ', false],
    [null, false],
    [undefined, false],
    [5, false],
  ])('isNonBlankString(%j) is %s', (value, expected) => {
    expect(isNonBlankString(value)).toBe(expected);
  });

  describe('validateTextField', () => {
    it.each([
      ['trims', '  Stereolab ', 'Stereolab'],
      ['accepts 128 astral code points', astral128, astral128],
      ['measures after trimming', `  ${'a'.repeat(128)}  `, 'a'.repeat(128)],
    ])('%s', (_name, input, expected) => {
      expect(validateTextField(input, 'artist_name', 128)).toBe(expected);
    });

    it.each([
      ['blank', '   ', 'artist_name must be a non-empty string'],
      ['empty', '', 'artist_name must be a non-empty string'],
      ['null', null, 'artist_name must be a non-empty string'],
      ['undefined', undefined, 'artist_name must be a non-empty string'],
      ['non-string', 42, 'artist_name must be a non-empty string'],
      ['over length', 'a'.repeat(129), 'artist_name must be 128 characters or fewer'],
    ])('rejects %s with a 400', (_name, input, message) => {
      expect.assertions(3);
      try {
        validateTextField(input, 'artist_name', 128);
      } catch (e) {
        expect(e).toBeInstanceOf(WxycError);
        expect((e as WxycError).statusCode).toBe(400);
        expect((e as WxycError).message).toBe(message);
      }
    });
  });

  describe('normalizeOptionalText', () => {
    it.each([
      ['undefined', undefined, undefined],
      ['null', null, null],
      ['empty', '', null],
      ['whitespace', '   ', null],
      ['trims', '  Drag City ', 'Drag City'],
      ['128 astral code points', astral128, astral128],
      ['a value padded past maxLength that fits once trimmed', `  ${'a'.repeat(128)}  `, 'a'.repeat(128)],
    ])('maps %s', (_name, input, expected) => {
      expect(normalizeOptionalText(input, 'record_label', 128)).toBe(expected);
    });

    it.each([
      ['non-string', 7, 'record_label must be a string or null'],
      ['over length', 'a'.repeat(129), 'record_label must be 128 characters or fewer'],
    ])('rejects %s with a 400', (_name, input, message) => {
      expect.assertions(2);
      try {
        normalizeOptionalText(input, 'record_label', 128);
      } catch (e) {
        expect((e as WxycError).statusCode).toBe(400);
        expect((e as WxycError).message).toBe(message);
      }
    });
  });
});
