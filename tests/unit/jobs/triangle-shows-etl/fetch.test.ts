/**
 * Unit tests for the triangle-shows-etl pull URL (BS#1589).
 *
 * The query string is contract, not plumbing: `dedup=false` +
 * `include_removed=true` + a back-dated `start` is the shipped
 * mirror-consumer recipe from triangle-shows Phase 0 — the default
 * start=today window hides a tombstone stamped on the event's own show
 * date, and source rows are hard-deleted 7 days past their date.
 */
import { backdatedStart, buildEventsUrl } from '../../../../jobs/triangle-shows-etl/fetch';

describe('backdatedStart', () => {
  it('returns the Eastern calendar date 8 days before the run moment', () => {
    // 2026-07-10T05:05Z is 2026-07-10 01:05 EDT; 8 days back is 2026-07-02.
    expect(backdatedStart(new Date('2026-07-10T05:05:00Z'))).toBe('2026-07-02');
  });

  it('anchors on the Eastern date, not the UTC date, when the two differ', () => {
    // 2026-07-10T03:30Z is still 2026-07-09 in New York.
    expect(backdatedStart(new Date('2026-07-10T03:30:00Z'))).toBe('2026-07-01');
  });

  it('crosses month boundaries correctly', () => {
    expect(backdatedStart(new Date('2026-08-04T12:00:00Z'))).toBe('2026-07-27');
  });
});

describe('buildEventsUrl', () => {
  it('carries dedup=false, include_removed=true, and the back-dated start', () => {
    const url = buildEventsUrl('https://triangle-shows-production.up.railway.app', new Date('2026-07-10T05:05:00Z'));
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/events');
    expect(parsed.searchParams.get('dedup')).toBe('false');
    expect(parsed.searchParams.get('include_removed')).toBe('true');
    expect(parsed.searchParams.get('start')).toBe('2026-07-02');
  });

  it('tolerates a trailing slash on the base URL', () => {
    const url = buildEventsUrl('https://example.com/', new Date('2026-07-10T05:05:00Z'));
    expect(new URL(url).pathname).toBe('/api/v1/events');
  });

  it('preserves a path prefix on the base URL (reverse-proxy subpath deploys) instead of resolving against the origin', () => {
    const url = buildEventsUrl('https://shared-host.example.org/triangle-shows', new Date('2026-07-10T05:05:00Z'));
    expect(new URL(url).pathname).toBe('/triangle-shows/api/v1/events');
  });
});

describe('fetchJson retry', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('retries once on a 5xx (Railway cold starts 502 briefly — same convention as rhp-fetch) and succeeds on the second attempt', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock;

    const { fetchJson } = await import('../../../../jobs/triangle-shows-etl/fetch');
    await expect(fetchJson('https://example.com/api/v1/venues', 5_000, 0)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx — the URL is wrong; retrying cannot help', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    global.fetch = fetchMock;

    const { fetchJson } = await import('../../../../jobs/triangle-shows-etl/fetch');
    await expect(fetchJson('https://example.com/api/v1/venues', 5_000, 0)).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails after the single retry when the 5xx persists', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
    global.fetch = fetchMock;

    const { fetchJson } = await import('../../../../jobs/triangle-shows-etl/fetch');
    await expect(fetchJson('https://example.com/api/v1/venues', 5_000, 0)).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
