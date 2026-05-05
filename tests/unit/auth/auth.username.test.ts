import {
  formatUsernameError,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  validateUsername,
} from '../../../shared/authentication/src/auth.username';

describe('validateUsername()', () => {
  describe('valid usernames', () => {
    it.each([
      ['lowercase', 'billb'],
      ['mixed case', 'BillB'],
      ['with underscore', 'bill_b'],
      ['with dot', 'bill.b'],
      ['digits only', '12345'],
      ['minimum length', 'a'.repeat(MIN_USERNAME_LENGTH)],
      ['maximum length', 'a'.repeat(MAX_USERNAME_LENGTH)],
    ])('should accept %s ("%s")', (_label, input) => {
      expect(validateUsername(input)).toBeNull();
    });
  });

  describe('rejected usernames', () => {
    it('should reject internal whitespace as invalid characters', () => {
      expect(validateUsername('bill b')).toEqual({ kind: 'invalid-characters' });
    });

    it('should reject leading whitespace as invalid characters', () => {
      expect(validateUsername(' billb')).toEqual({ kind: 'invalid-characters' });
    });

    it('should reject trailing whitespace as invalid characters', () => {
      expect(validateUsername('billb ')).toEqual({ kind: 'invalid-characters' });
    });

    it.each([
      ['dash', 'bill-b'],
      ['at', 'bill@b'],
      ['apostrophe', "bill's"],
      ['unicode letter', 'billé'],
      ['emoji', 'bill\u{1F44D}'],
    ])('should reject %s as invalid-characters', (_label, input) => {
      expect(validateUsername(input)).toEqual({ kind: 'invalid-characters' });
    });

    it('should reject empty string as too-short', () => {
      expect(validateUsername('')).toEqual({ kind: 'too-short', min: MIN_USERNAME_LENGTH });
    });

    it('should reject one-character string as too-short', () => {
      expect(validateUsername('a')).toEqual({ kind: 'too-short', min: MIN_USERNAME_LENGTH });
    });

    it('should reject MIN-1 character string as too-short', () => {
      expect(validateUsername('a'.repeat(MIN_USERNAME_LENGTH - 1))).toEqual({
        kind: 'too-short',
        min: MIN_USERNAME_LENGTH,
      });
    });

    it('should reject MAX+1 character string as too-long', () => {
      expect(validateUsername('a'.repeat(MAX_USERNAME_LENGTH + 1))).toEqual({
        kind: 'too-long',
        max: MAX_USERNAME_LENGTH,
      });
    });
  });
});

describe('formatUsernameError()', () => {
  it('should describe too-short with the minimum length', () => {
    expect(formatUsernameError({ kind: 'too-short', min: 3 })).toBe('Username must be at least 3 characters.');
  });

  it('should describe too-long with the maximum length', () => {
    expect(formatUsernameError({ kind: 'too-long', max: 30 })).toBe('Username must be at most 30 characters.');
  });

  it('should describe invalid-characters and mention spaces', () => {
    const message = formatUsernameError({ kind: 'invalid-characters' });
    expect(message).toMatch(/letters/i);
    expect(message).toMatch(/no spaces/i);
  });
});
