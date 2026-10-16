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

  describe('IPv6 normalization (BS#2193)', () => {
    it('keys two addresses inside one /56 identically', () => {
      const a = rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': '2001:db8:abcd:1200::1' } }));
      const b = rateLimitKeyFromRequest(
        makeReq({ headers: { 'x-real-ip': '2001:db8:abcd:12ff:aaaa:bbbb:cccc:dddd' } })
      );
      expect(a).toBe(b);
      expect(a).toBe('2001:db8:abcd:1200::/56');
    });

    it('keys addresses in different /56s differently', () => {
      const a = rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': '2001:db8:abcd:1200::1' } }));
      const b = rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': '2001:db8:abcd:1300::1' } }));
      expect(a).not.toBe(b);
    });

    it('normalizes an IPv6 socket address when X-Real-IP is missing', () => {
      const key = rateLimitKeyFromRequest(makeReq({ headers: {}, remoteAddress: '2001:db8:abcd:12ff::9' }));
      expect(key).toBe('2001:db8:abcd:1200::/56');
    });

    it.each([
      ['an IPv4 address', '203.0.113.7', '203.0.113.7'],
      ['an IPv4-mapped IPv6 address (collapses to its IPv4 form)', '::ffff:203.0.113.7', '203.0.113.7'],
    ])('leaves %s keyed by its IPv4 form', (_label, input, expected) => {
      expect(rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': input } }))).toBe(expected);
    });
  });

  describe('IP-less requests (BS#2190)', () => {
    const noIp = (headers: Record<string, string>) =>
      rateLimitKeyFromRequest(makeReq({ headers, remoteAddress: undefined }));

    it('no longer returns the shared literal "unknown"', () => {
      expect(noIp({})).not.toBe('unknown');
    });

    it('is stable for identical signals', () => {
      expect(noIp({ 'user-agent': 'curl/8', host: 'api.wxyc.org' })).toBe(
        noIp({ 'user-agent': 'curl/8', host: 'api.wxyc.org' })
      );
    });

    it.each([
      ['user-agent', { 'user-agent': 'curl/8' }, { 'user-agent': 'okhttp/4' }],
      ['host', { host: 'a.wxyc.org' }, { host: 'b.wxyc.org' }],
      ['bearer token', { authorization: 'Bearer aaa' }, { authorization: 'Bearer bbb' }],
      ['session cookie', { cookie: 'better-auth.session_token=aaa' }, { cookie: 'better-auth.session_token=bbb' }],
    ])('differs when the %s differs', (_label, a, b) => {
      expect(noIp(a)).not.toBe(noIp(b));
    });

    it('never embeds a raw credential in the key', () => {
      const key = noIp({
        authorization: 'Bearer super-secret-token',
        cookie: 'better-auth.session_token=cookie-secret',
      });
      expect(key).not.toContain('super-secret-token');
      expect(key).not.toContain('cookie-secret');
    });

    it('logs exactly once per process, not once per request', () => {
      jest.isolateModules(() => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { rateLimitKeyFromRequest: fresh } = require('../../../apps/auth/rate-limit-key');
        fresh(makeReq({ headers: {}, remoteAddress: undefined }));
        fresh(makeReq({ headers: { 'user-agent': 'x' }, remoteAddress: undefined }));
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
      });
    });

    it('does not log when an IP resolves', () => {
      jest.isolateModules(() => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { rateLimitKeyFromRequest: fresh } = require('../../../apps/auth/rate-limit-key');
        fresh(makeReq({ headers: { 'x-real-ip': '203.0.113.7' } }));
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
      });
    });
  });

  it('uses the first value when X-Real-IP is an array (Node header-parsing edge case)', () => {
    const key = rateLimitKeyFromRequest(
      makeReq({ headers: { 'x-real-ip': ['203.0.113.7', '203.0.113.8'] }, remoteAddress: '10.0.0.1' })
    );
    expect(key).toBe('203.0.113.7');
  });
});
