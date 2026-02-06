import { rewriteUrlForFrontend } from '../../../shared/authentication/src/auth.definition';

describe('rewriteUrlForFrontend', () => {
  const originalEnv = process.env.FRONTEND_SOURCE;

  afterEach(() => {
    if (originalEnv) {
      process.env.FRONTEND_SOURCE = originalEnv;
    } else {
      delete process.env.FRONTEND_SOURCE;
    }
  });

  it('replaces host and protocol while preserving path and query params', () => {
    process.env.FRONTEND_SOURCE = 'https://dj.wxyc.org';
    const input =
      'https://api.wxyc.org/auth/verify-email?token=abc123&callbackURL=%2Fonboarding';
    const result = rewriteUrlForFrontend(input);

    expect(result).toBe(
      'https://dj.wxyc.org/auth/verify-email?token=abc123&callbackURL=%2Fonboarding'
    );
  });

  it('handles URLs without query params', () => {
    process.env.FRONTEND_SOURCE = 'https://dj.wxyc.org';
    const input = 'https://api.wxyc.org/auth/reset-password/token123';
    const result = rewriteUrlForFrontend(input);

    expect(result).toBe('https://dj.wxyc.org/auth/reset-password/token123');
  });

  it('preserves complex query parameters', () => {
    process.env.FRONTEND_SOURCE = 'https://dj.wxyc.org';
    const input =
      'https://api.wxyc.org/auth/verify-email?token=xyz&callbackURL=%2Fdashboard&redirectTo=%2Fhome';
    const result = rewriteUrlForFrontend(input);

    expect(result).toBe(
      'https://dj.wxyc.org/auth/verify-email?token=xyz&callbackURL=%2Fdashboard&redirectTo=%2Fhome'
    );
  });

  it('handles invalid URLs gracefully by returning original', () => {
    process.env.FRONTEND_SOURCE = 'https://dj.wxyc.org';
    const input = 'not-a-valid-url';
    const result = rewriteUrlForFrontend(input);

    expect(result).toBe('not-a-valid-url');
  });

  it('uses default localhost when FRONTEND_SOURCE is not set', () => {
    delete process.env.FRONTEND_SOURCE;
    const input = 'https://api.wxyc.org/auth/verify-email?token=test';
    const result = rewriteUrlForFrontend(input);

    expect(result).toBe('http://localhost:3000/auth/verify-email?token=test');
  });

  it('handles different protocols correctly', () => {
    process.env.FRONTEND_SOURCE = 'http://localhost:3000';
    const input = 'https://api.wxyc.org/auth/verify-email';
    const result = rewriteUrlForFrontend(input);

    expect(result).toBe('http://localhost:3000/auth/verify-email');
  });

  it('preserves port numbers in frontend URL', () => {
    process.env.FRONTEND_SOURCE = 'http://localhost:8080';
    const input = 'https://api.wxyc.org/auth/verify-email';
    const result = rewriteUrlForFrontend(input);

    expect(result).toBe('http://localhost:8080/auth/verify-email');
  });
});
