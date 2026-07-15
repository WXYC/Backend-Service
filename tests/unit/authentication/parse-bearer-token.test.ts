// Mock jose so importing auth.middleware (which imports jose at module scope)
// doesn't pull the real ESM module into the pure-helper test.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

import { parseBearerToken } from '../../../shared/authentication/src/auth.middleware';

describe('parseBearerToken', () => {
  it('parses a canonical "Bearer <token>" header', () => {
    expect(parseBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('parses a lowercase "bearer" scheme (RFC 6750 §2.1 case-insensitive)', () => {
    expect(parseBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('parses an uppercase "BEARER" scheme', () => {
    expect(parseBearerToken('BEARER abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('parses a mixed-case "BeArEr" scheme', () => {
    expect(parseBearerToken('BeArEr abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('tolerates multiple whitespace characters between scheme and token', () => {
    expect(parseBearerToken('Bearer   abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('trims trailing whitespace from the token', () => {
    expect(parseBearerToken('Bearer abc.def.ghi   ')).toBe('abc.def.ghi');
  });

  it('returns null for undefined (missing header)', () => {
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseBearerToken('')).toBeNull();
  });

  it('returns null for a bare "Bearer" with no token', () => {
    expect(parseBearerToken('Bearer')).toBeNull();
  });

  it('returns null for "Bearer " with only trailing whitespace', () => {
    expect(parseBearerToken('Bearer   ')).toBeNull();
  });

  it('returns null for a plain token with no Bearer scheme', () => {
    expect(parseBearerToken('abc.def.ghi')).toBeNull();
  });

  it('returns null for a non-Bearer scheme (e.g. Basic)', () => {
    expect(parseBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });
});
