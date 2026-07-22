import { Request } from 'express';
import { rateLimitKeyFromRequest } from '../../../apps/backend/middleware/rate-limit-key';

const makeReq = (overrides: {
  auth?: { id?: string };
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string | undefined;
}) =>
  ({
    auth: overrides.auth,
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress },
  }) as unknown as Request;

describe('rateLimitKeyFromRequest', () => {
  it('keys an authenticated caller on their user id, namespaced', () => {
    const key = rateLimitKeyFromRequest(makeReq({ auth: { id: 'user-123' }, remoteAddress: '10.0.0.1' }));
    expect(key).toBe('user:user-123');
  });

  it('gives two different unauthenticated IPs independent buckets', () => {
    const keyA = rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': '203.0.113.7' } }));
    const keyB = rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': '198.51.100.2' } }));

    expect(keyA).toBe('ip:203.0.113.7');
    expect(keyB).toBe('ip:198.51.100.2');
    expect(keyA).not.toBe(keyB);
  });

  it('never collapses unauthenticated callers into a single shared bucket', () => {
    // The BS#1127 bug: every anonymous caller shared the literal 'unknown'
    // key, so one client's traffic rate-limited everyone. Distinct IPs must
    // never map to the same key.
    const keys = ['203.0.113.7', '198.51.100.2', '192.0.2.9'].map((ip) =>
      rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': ip } }))
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ignores client-supplied X-Forwarded-For — only X-Real-IP is trusted (BS#774/#1048)', () => {
    const key = rateLimitKeyFromRequest(
      makeReq({
        headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '203.0.113.7' },
        remoteAddress: '10.0.0.1',
      })
    );
    expect(key).toBe('ip:203.0.113.7');
  });

  it('falls back to the socket address when X-Real-IP is missing', () => {
    const key = rateLimitKeyFromRequest(makeReq({ headers: {}, remoteAddress: '10.0.0.1' }));
    expect(key).toBe('ip:10.0.0.1');
  });

  it('uses the first value when X-Real-IP is an array (Node header-parsing edge case)', () => {
    const key = rateLimitKeyFromRequest(
      makeReq({ headers: { 'x-real-ip': ['203.0.113.7', '203.0.113.8'] }, remoteAddress: '10.0.0.1' })
    );
    expect(key).toBe('ip:203.0.113.7');
  });

  it('falls back to ip:unknown only when neither X-Real-IP nor a socket address is available', () => {
    const key = rateLimitKeyFromRequest(makeReq({ headers: {}, remoteAddress: undefined }));
    expect(key).toBe('ip:unknown');
  });

  it('cannot let an attacker collide the user and IP key spaces', () => {
    // A caller who sets their user id to a victim's IP must land in a
    // different bucket than that IP's anonymous traffic — the namespace
    // prefixes guarantee it.
    const spoofedUserKey = rateLimitKeyFromRequest(makeReq({ auth: { id: '203.0.113.7' } }));
    const victimIpKey = rateLimitKeyFromRequest(makeReq({ headers: { 'x-real-ip': '203.0.113.7' } }));
    expect(spoofedUserKey).toBe('user:203.0.113.7');
    expect(victimIpKey).toBe('ip:203.0.113.7');
    expect(spoofedUserKey).not.toBe(victimIpKey);
  });
});
