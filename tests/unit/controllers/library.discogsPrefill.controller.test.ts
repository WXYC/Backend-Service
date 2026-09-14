/**
 * Unit tests for the Discogs autopopulate endpoint
 * (`GET /library/releases/discogs-prefill?url=`): the URL/id extractor
 * (`parseDiscogsReleaseIdInput`) and the `getDiscogsReleasePrefill` handler.
 * The library service is mocked so the tests cover URL parsing, the named-4xx
 * failure mapping, and the 200 passthrough without a live LML.
 */

import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import WxycError from '../../../apps/backend/utils/error';

const mockResolveDiscogsReleasePrefill = jest.fn<(releaseId: number) => Promise<Record<string, unknown> | null>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  resolveDiscogsReleasePrefill: mockResolveDiscogsReleasePrefill,
}));

jest.mock('../../../apps/backend/services/labels.service', () => ({}));
jest.mock('../../../apps/backend/services/library-search.service', () => ({}));

jest.mock('@wxyc/lml-client', () => ({
  checkStreamingAvailability: jest.fn(),
  isLmlConfigured: jest.fn(() => true),
  envInt: (_name: string, fallback: number) => fallback,
}));

jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: () => Promise.resolve(null) },
}));

jest.mock('../../../apps/backend/utils/posthog', () => ({
  getPostHogClient: () => ({ capture: jest.fn() }),
}));

jest.mock('@sentry/node', () => ({
  getActiveSpan: () => ({ setAttributes: jest.fn() }),
}));

import {
  getDiscogsReleasePrefill,
  parseDiscogsReleaseIdInput,
} from '../../../apps/backend/controllers/library.controller';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

describe('parseDiscogsReleaseIdInput', () => {
  it.each([
    ['https://www.discogs.com/release/249504', 249504],
    ['https://www.discogs.com/release/249504-Juana-Molina-Segundo', 249504],
    ['https://www.discogs.com/Juana-Molina-Segundo/release/249504', 249504],
    ['http://discogs.com/release/249504', 249504],
    ['www.discogs.com/release/249504', 249504],
    ['discogs.com/release/249504', 249504],
    ['https://www.discogs.com/release/249504?ev=item-vc', 249504],
    // A slug containing the word "master" must not be mistaken for a master link.
    ['https://www.discogs.com/Grandmaster-Flash/release/12345', 12345],
    // Bare numeric id.
    ['249504', 249504],
    ['  249504  ', 249504],
  ])('extracts a release id from %s', (input, expected) => {
    expect(parseDiscogsReleaseIdInput(input)).toEqual({ ok: true, releaseId: expected });
  });

  it('rejects a master link with the master_url reason', () => {
    expect(parseDiscogsReleaseIdInput('https://www.discogs.com/master/55123')).toEqual({
      ok: false,
      code: 'master_url',
      message: expect.stringContaining('master'),
    });
    expect(parseDiscogsReleaseIdInput('https://www.discogs.com/Juana-Molina/master/55123')).toMatchObject({
      ok: false,
      code: 'master_url',
    });
  });

  it('rejects an empty / whitespace input as missing_url', () => {
    expect(parseDiscogsReleaseIdInput('')).toMatchObject({ ok: false, code: 'missing_url' });
    expect(parseDiscogsReleaseIdInput('   ')).toMatchObject({ ok: false, code: 'missing_url' });
  });

  it('rejects a non-Discogs URL as invalid_url', () => {
    expect(parseDiscogsReleaseIdInput('https://example.com/release/249504')).toMatchObject({
      ok: false,
      code: 'invalid_url',
    });
    expect(parseDiscogsReleaseIdInput('not even a url')).toMatchObject({ ok: false, code: 'invalid_url' });
  });

  it('rejects a Discogs URL that is not a release link as not_release_url', () => {
    expect(parseDiscogsReleaseIdInput('https://www.discogs.com/artist/314159')).toMatchObject({
      ok: false,
      code: 'not_release_url',
    });
  });
});

describe('getDiscogsReleasePrefill', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
    mockResolveDiscogsReleasePrefill.mockReset();
  });

  const prefill = {
    discogs_release_id: 249504,
    discogs_master_id: 55123,
    artist_name: 'Juana Molina',
    album_title: 'DOGA',
    label: 'Sonamos',
    label_id: 27182,
    year: 2022,
    discogs_artist_id: 314159,
    genres: ['Rock'],
    styles: [],
    artwork_url: null,
  };

  it('returns 200 with the prefill for a valid release URL', async () => {
    mockResolveDiscogsReleasePrefill.mockResolvedValue(prefill);
    const req = { query: { url: 'https://www.discogs.com/release/249504' } } as unknown as Request;
    const res = mockResponse();

    await getDiscogsReleasePrefill(req, res, next);

    expect(mockResolveDiscogsReleasePrefill).toHaveBeenCalledWith(249504);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(prefill);
  });

  it('accepts a bare numeric id', async () => {
    mockResolveDiscogsReleasePrefill.mockResolvedValue(prefill);
    const req = { query: { url: '249504' } } as unknown as Request;
    const res = mockResponse();

    await getDiscogsReleasePrefill(req, res, next);

    expect(mockResolveDiscogsReleasePrefill).toHaveBeenCalledWith(249504);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('throws a 400 missing_url when the url query param is absent', async () => {
    const req = { query: {} } as unknown as Request;
    const res = mockResponse();

    await expect(getDiscogsReleasePrefill(req, res, next)).rejects.toMatchObject({
      statusCode: 400,
      code: 'missing_url',
    });
    expect(mockResolveDiscogsReleasePrefill).not.toHaveBeenCalled();
  });

  it('throws a 400 missing_url when the url query param is repeated (array)', async () => {
    const req = { query: { url: ['a', 'b'] } } as unknown as Request;
    const res = mockResponse();

    await expect(getDiscogsReleasePrefill(req, res, next)).rejects.toMatchObject({
      statusCode: 400,
      code: 'missing_url',
    });
    expect(mockResolveDiscogsReleasePrefill).not.toHaveBeenCalled();
  });

  it('throws a 400 with the parse code for an invalid URL', async () => {
    const req = { query: { url: 'https://example.com/nope' } } as unknown as Request;
    const res = mockResponse();

    const err = await getDiscogsReleasePrefill(req, res, next).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WxycError);
    expect(err).toMatchObject({ statusCode: 400, code: 'invalid_url' });
    expect(mockResolveDiscogsReleasePrefill).not.toHaveBeenCalled();
  });

  it('throws a 400 master_url for a master link (documented reject rule)', async () => {
    const req = { query: { url: 'https://www.discogs.com/master/55123' } } as unknown as Request;
    const res = mockResponse();

    await expect(getDiscogsReleasePrefill(req, res, next)).rejects.toMatchObject({
      statusCode: 400,
      code: 'master_url',
    });
    expect(mockResolveDiscogsReleasePrefill).not.toHaveBeenCalled();
  });

  it('throws a named 404 when LML has no such release', async () => {
    mockResolveDiscogsReleasePrefill.mockResolvedValue(null);
    const req = { query: { url: 'https://www.discogs.com/release/999999999' } } as unknown as Request;
    const res = mockResponse();

    await expect(getDiscogsReleasePrefill(req, res, next)).rejects.toMatchObject({
      statusCode: 404,
      code: 'release_not_found',
    });
    expect(mockResolveDiscogsReleasePrefill).toHaveBeenCalledWith(999999999);
  });

  it('lets a hard LML failure bubble (never a 500 from this handler itself)', async () => {
    const upstream = Object.assign(new Error('bad gateway'), { statusCode: 502 });
    mockResolveDiscogsReleasePrefill.mockRejectedValue(upstream);
    const req = { query: { url: 'https://www.discogs.com/release/249504' } } as unknown as Request;
    const res = mockResponse();

    await expect(getDiscogsReleasePrefill(req, res, next)).rejects.toBe(upstream);
  });
});
