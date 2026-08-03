import {
  accountSetupTokenExpiresInSeconds,
  ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS,
} from '../../../shared/authentication/src/account-setup-token';

describe('accountSetupTokenExpiresInSeconds()', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.ACCOUNT_SETUP_TOKEN_EXPIRES_IN;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults to 7 days when the var is unset', () => {
    expect(accountSetupTokenExpiresInSeconds()).toBe(ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS);
    expect(ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS).toBe(60 * 60 * 24 * 7);
  });

  it('honors a positive integer override (with surrounding whitespace)', () => {
    process.env.ACCOUNT_SETUP_TOKEN_EXPIRES_IN = '  3600  ';
    expect(accountSetupTokenExpiresInSeconds()).toBe(3600);
  });

  it('floors a fractional value to whole seconds', () => {
    process.env.ACCOUNT_SETUP_TOKEN_EXPIRES_IN = '3600.9';
    expect(accountSetupTokenExpiresInSeconds()).toBe(3600);
  });

  // Regression guard: Number() (not parseInt) so "3600abc" does NOT silently
  // parse to 3600 — it falls back to the default per docs/env-vars.md.
  it.each(['3600abc', 'abc', '', '   ', '0', '-5', 'NaN', 'Infinity'])(
    'falls back to the default for the non-numeric / non-positive value %p',
    (value) => {
      process.env.ACCOUNT_SETUP_TOKEN_EXPIRES_IN = value;
      expect(accountSetupTokenExpiresInSeconds()).toBe(ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS);
    }
  );
});
