// Unit test for #715: lookupMetadata wraps fetch in Sentry.startSpan and projects cache_stats.

import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

const mockSpanSetAttributes = jest.fn();
type SpanLike = { setAttributes: typeof mockSpanSetAttributes };
const mockStartSpan = jest.fn(
  async (_opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    await callback({ setAttributes: mockSpanSetAttributes })
);
jest.mock('@sentry/node', () => ({
  startSpan: (opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    mockStartSpan(opts, callback),
}));

import { lookupMetadata } from '../../../../jobs/flowsheet-metadata-backfill/lml-fetch';

describe('jobs/flowsheet-metadata-backfill/lml-fetch', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('lookupMetadata Sentry instrumentation (#715)', () => {
    it('wraps the call in a Sentry span with name=lml.lookup, op=http.client', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none' }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield', 'VI Scose Poise');

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockStartSpan.mock.calls[0][0]).toEqual({ name: 'lml.lookup', op: 'http.client' });
    });

    it('projects numeric cache_stats fields onto the span as lml.cache.<key>', async () => {
      const cache_stats = {
        memory_hits: 1,
        pg_hits: 4,
        pg_misses: 2,
        api_calls: 3,
        pg_time_ms: 7.5,
        api_time_ms: 250,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none', cache_stats }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield');

      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
        'lml.cache.memory_hits': 1,
        'lml.cache.pg_hits': 4,
        'lml.cache.pg_misses': 2,
        'lml.cache.api_calls': 3,
        'lml.cache.pg_time_ms': 7.5,
        'lml.cache.api_time_ms': 250,
      });
    });

    it('does not call setAttributes when LML response omits cache_stats', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none' }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
      expect(mockSpanSetAttributes).not.toHaveBeenCalled();
    });

    it('does not call setAttributes when cache_stats is an array (defensive narrowing)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none', cache_stats: [1, 2, 3] }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre');

      expect(mockSpanSetAttributes).not.toHaveBeenCalled();
    });

    it('resolves the lookup even when span.setAttributes throws', async () => {
      const lookupResponse = { results: [], search_type: 'none' as const, cache_stats: { memory_hits: 1 } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(lookupResponse),
      } as unknown as globalThis.Response);
      mockSpanSetAttributes.mockImplementation(() => {
        throw new Error('sentry boom');
      });

      const result = await lookupMetadata('Autechre');

      expect(result).toEqual(lookupResponse);
    });
  });

  // Pin the wire-format field name so the silent drop documented in #888
  // can't recur. LML's LookupRequest schema (wxyc-shared/api.yaml) names the
  // field `song`; FastAPI/Pydantic silently drops unknown keys, so a typo
  // here would degrade the backfill to artist+album-only without any error.
  describe('LML LookupRequest wire shape (#888 regression)', () => {
    it('sends the track title under body.song (not body.track)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none' }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield', 'VI Scose Poise');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = mockFetch.mock.calls[0][1];
      const body = JSON.parse(init?.body as string);
      expect(body.song).toBe('VI Scose Poise');
      expect(body).not.toHaveProperty('track');
    });

    it('omits the song field when no track is supplied', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [], search_type: 'none' }),
      } as unknown as globalThis.Response);

      await lookupMetadata('Autechre', 'Confield');

      const init = mockFetch.mock.calls[0][1];
      const body = JSON.parse(init?.body as string);
      expect(body).not.toHaveProperty('song');
      expect(body).not.toHaveProperty('track');
    });
  });
});
