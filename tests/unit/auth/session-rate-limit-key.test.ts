import { sessionRateLimitKeyFromRequest } from '../../../apps/auth/rate-limit-key';

const makeReq = (overrides: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string | undefined;
}) =>
  ({
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress },
  }) as Parameters<typeof sessionRateLimitKeyFromRequest>[0];

describe('sessionRateLimitKeyFromRequest', () => {
  it('keys a __Secure- prefixed session cookie (production shape)', () => {
    const key = sessionRateLimitKeyFromRequest(
      makeReq({ headers: { cookie: '__Secure-better-auth.session_token=abc123' } })
    );
    expect(key).toMatch(/^session:[0-9a-f]{16}$/);
  });

  it('produces an identical key for the same cookie value across two requests', () => {
    const build = () => makeReq({ headers: { cookie: '__Secure-better-auth.session_token=abc123' } });
    expect(sessionRateLimitKeyFromRequest(build())).toBe(sessionRateLimitKeyFromRequest(build()));
  });

  it('produces different keys for different cookie values', () => {
    const key1 = sessionRateLimitKeyFromRequest(
      makeReq({ headers: { cookie: '__Secure-better-auth.session_token=abc123' } })
    );
    const key2 = sessionRateLimitKeyFromRequest(
      makeReq({ headers: { cookie: '__Secure-better-auth.session_token=xyz789' } })
    );
    expect(key1).not.toBe(key2);
  });

  it('matches the unprefixed better-auth.session_token cookie (non-production cookie shape)', () => {
    const key = sessionRateLimitKeyFromRequest(makeReq({ headers: { cookie: 'better-auth.session_token=abc123' } }));
    expect(key).toMatch(/^session:[0-9a-f]{16}$/);
  });

  it('keys on Authorization: Bearer <token> when present', () => {
    const key = sessionRateLimitKeyFromRequest(makeReq({ headers: { authorization: 'Bearer sometoken' } }));
    expect(key).toMatch(/^bearer:[0-9a-f]{16}$/);
  });

  it('prefers the bearer token over a session cookie when both are present', () => {
    const key = sessionRateLimitKeyFromRequest(
      makeReq({
        headers: {
          authorization: 'Bearer sometoken',
          cookie: '__Secure-better-auth.session_token=abc123',
        },
      })
    );
    expect(key.startsWith('bearer:')).toBe(true);
  });

  it('falls back to ip:<x-real-ip> when neither a session cookie nor a bearer token is present', () => {
    const key = sessionRateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': '203.0.113.7' } }));
    expect(key).toBe('ip:203.0.113.7');
  });

  it('falls back to the socket address when x-real-ip is also absent', () => {
    const key = sessionRateLimitKeyFromRequest(makeReq({ headers: {}, remoteAddress: '10.0.0.1' }));
    expect(key).toBe('ip:10.0.0.1');
  });

  it('falls back to ip:unknown when neither x-real-ip nor a socket address is available', () => {
    const key = sessionRateLimitKeyFromRequest(makeReq({ headers: {}, remoteAddress: undefined }));
    expect(key).toBe('ip:unknown');
  });

  it('never leaks the raw cookie value into the key', () => {
    const key = sessionRateLimitKeyFromRequest(
      makeReq({ headers: { cookie: '__Secure-better-auth.session_token=super-secret-cookie-value' } })
    );
    expect(key).not.toContain('super-secret-cookie-value');
  });

  it('never leaks the raw bearer token into the key', () => {
    const key = sessionRateLimitKeyFromRequest(makeReq({ headers: { authorization: 'Bearer super-secret-token' } }));
    expect(key).not.toContain('super-secret-token');
  });

  it('parses the session cookie out of a Cookie header carrying other cookies around it, including a value containing "="', () => {
    const key = sessionRateLimitKeyFromRequest(
      makeReq({ headers: { cookie: 'other=1; __Secure-better-auth.session_token=abc.def=; third=2' } })
    );
    const directKey = sessionRateLimitKeyFromRequest(
      makeReq({ headers: { cookie: '__Secure-better-auth.session_token=abc.def=' } })
    );
    expect(key).toBe(directKey);
    expect(key).toMatch(/^session:[0-9a-f]{16}$/);
  });
});
