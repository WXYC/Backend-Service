import { rateLimitKeyFromRequest } from '../../../apps/auth/rate-limit-key';

const makeReq = (overrides: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string | undefined;
}) =>
  ({
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress },
  }) as Parameters<typeof rateLimitKeyFromRequest>[0];

describe('rateLimitKeyFromRequest', () => {
  it('ignores client-supplied X-Forwarded-For — only X-Real-IP is trusted', () => {
    const key = rateLimitKeyFromRequest(
      makeReq({
        headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '203.0.113.7' },
        remoteAddress: '10.0.0.1',
      })
    );
    expect(key).toBe('203.0.113.7');
  });

  it('falls back to the socket address when X-Real-IP is missing', () => {
    const key = rateLimitKeyFromRequest(makeReq({ headers: {}, remoteAddress: '10.0.0.1' }));
    expect(key).toBe('10.0.0.1');
  });

  it('returns "unknown" when neither X-Real-IP nor a socket address is available', () => {
    const key = rateLimitKeyFromRequest(makeReq({ headers: {}, remoteAddress: undefined }));
    expect(key).toBe('unknown');
  });

  it('uses the first value when X-Real-IP is an array (Node header-parsing edge case)', () => {
    const key = rateLimitKeyFromRequest(
      makeReq({ headers: { 'x-real-ip': ['203.0.113.7', '203.0.113.8'] }, remoteAddress: '10.0.0.1' })
    );
    expect(key).toBe('203.0.113.7');
  });
});
