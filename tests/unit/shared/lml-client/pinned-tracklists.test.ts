/**
 * `getPinnedTracklists`: the client for LML's `POST /api/v1/identity/pinned-tracklists`
 * (LML#1503, wxyc-shared#783), first used by `album-metadata-extended-fill` (BS#1442) to skip
 * rows whose stored release disagrees with the hand-verified pin.
 *
 * What matters: the body carries `library.legacy_release_id` values exactly as given, the
 * caller's class timeout applies, a 503 surfaces as an error (never as a null pin), and an
 * answer that does not line up with the request is refused rather than misattributed.
 */

import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

import {
  LmlAuthError,
  LmlClientError,
  PINNED_TRACKLISTS_BATCH_CAP,
  getPinnedTracklists,
  type PinnedTracklistsResult,
} from '@wxyc/lml-client';

const respond = (status: number, body: unknown) =>
  mockFetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
  } as unknown as globalThis.Response);

const PIN = { discogs_release_id: 530321, source: 'alex-2026-10', in_cache: true, tracks: [] };

describe('getPinnedTracklists', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000', LML_API_KEY: 'k'.repeat(16) };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('POSTs the legacy release ids as given and returns the results in request order', async () => {
    const results: PinnedTracklistsResult[] = [
      { legacy_release_id: 39541, pin: PIN },
      { legacy_release_id: 1442, pin: null },
    ];
    respond(200, { results });

    expect(await getPinnedTracklists([39541, 1442], { caller: 'album-metadata-extended-fill' })).toEqual(results);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://lml.test:8000/api/v1/identity/pinned-tracklists');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ legacy_release_ids: [39541, 1442] });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${'k'.repeat(16)}`);
  });

  it('keeps repeated ids, since LML fans them back out by position', async () => {
    respond(200, {
      results: [
        { legacy_release_id: 7, pin: null },
        { legacy_release_id: 7, pin: null },
      ],
    });

    expect(await getPinnedTracklists([7, 7])).toHaveLength(2);
    expect(JSON.parse(mockFetch.mock.calls[0][1]?.body as string)).toEqual({ legacy_release_ids: [7, 7] });
  });

  it.each([
    ['an empty list', []],
    ['more than the cap', Array.from({ length: PINNED_TRACKLISTS_BATCH_CAP + 1 }, (_, i) => i + 1)],
  ])('refuses %s client-side with a 400 and makes no call', async (_label, ids) => {
    await expect(getPinnedTracklists(ids)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a 503 (transient, never a null pin)', 503, 502],
    ['a 422 (input error)', 422, 422],
  ])('throws LmlClientError on %s', async (_label, status, statusCode) => {
    respond(status, { detail: 'x' });

    const error = await getPinnedTracklists([1]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LmlClientError);
    expect(error).toMatchObject({ statusCode });
  });

  it('throws LmlAuthError on a rejected bearer', async () => {
    respond(403, {});

    await expect(getPinnedTracklists([1])).rejects.toBeInstanceOf(LmlAuthError);
  });

  it.each([
    ['no results array', {}],
    ['fewer results than ids', { results: [{ legacy_release_id: 1, pin: null }] }],
    [
      'results out of request order',
      {
        results: [
          { legacy_release_id: 2, pin: null },
          { legacy_release_id: 1, pin: null },
        ],
      },
    ],
  ])('refuses an answer with %s as a 502 rather than misattributing pins', async (_label, body) => {
    respond(200, body);

    await expect(getPinnedTracklists([1, 2])).rejects.toMatchObject({ statusCode: 502 });
  });
});
