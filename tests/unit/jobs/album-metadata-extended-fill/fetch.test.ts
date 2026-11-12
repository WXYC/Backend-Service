/**
 * The extended fill's LML fetch layer (BS#1442): what each call reports, the
 * per-run artist memo, and the pacing shared by release and artist calls.
 *
 * The memo must never hold a failure. Many albums share an artist, and a
 * failed fetch memoized would leave every later album of that artist without
 * its artist columns for the rest of the run.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual<Record<string, unknown>>('@wxyc/lml-client'),
  getRelease: jest.fn(),
  getArtistDetails: jest.fn(),
  getPinnedTracklists: jest.fn(),
}));

import {
  LmlAuthError,
  LmlClientError,
  getArtistDetails as getArtistDetailsImport,
  getPinnedTracklists as getPinnedTracklistsImport,
  getRelease as getReleaseImport,
} from '@wxyc/lml-client';
import { createLmlFetcher, createPacer } from '../../../../jobs/album-metadata-extended-fill/fetch';

const getRelease = getReleaseImport as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const getArtistDetails = getArtistDetailsImport as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const getPinnedTracklists = getPinnedTracklistsImport as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const noPacing = { wait: () => Promise.resolve() };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createLmlFetcher', () => {
  it('fetches a release under its own caller label and reports it answered', async () => {
    getRelease.mockResolvedValue({ release_id: 7, cached: true });
    const fetcher = createLmlFetcher(noPacing);

    const fetched = await fetcher.release(7);

    expect(fetched).toMatchObject({ ok: true, value: { release_id: 7, cached: true } });
    expect(getRelease).toHaveBeenCalledWith(7, { caller: 'album-metadata-extended-fill' });
    expect(fetcher.calls()).toBe(1);
  });

  it.each([
    ['a 404', new LmlClientError('LML responded with 404', 404), 404],
    ['a 5xx (mapped to 502)', new LmlClientError('LML responded with 502', 502), 502],
    ['a timeout', new LmlClientError('LML request timed out', 504), 504],
    ['an unparseable body', new SyntaxError('Unexpected token'), 502],
  ])('reports %s as a failure with its status', async (_label, error, status) => {
    getRelease.mockRejectedValue(error);

    expect(await createLmlFetcher(noPacing).release(7)).toEqual({ ok: false, status });
  });

  it.each([401, 403] as const)('rethrows an auth rejection (%s): it is fatal to the run', async (status) => {
    getRelease.mockRejectedValue(new LmlAuthError('rejected', status));

    await expect(createLmlFetcher(noPacing).release(7)).rejects.toBeInstanceOf(LmlAuthError);
  });

  it('asks LML for an artist once per run when it answers', async () => {
    getArtistDetails.mockResolvedValue({ artist_id: 82730, name: 'Juana Molina' });
    const fetcher = createLmlFetcher(noPacing);

    await fetcher.artist(82730);
    const second = await fetcher.artist(82730);

    expect(second).toMatchObject({ ok: true, memoized: true });
    expect(getArtistDetails).toHaveBeenCalledTimes(1);
    expect(getArtistDetails).toHaveBeenCalledWith(82730, { caller: 'album-metadata-extended-fill' });
    expect(fetcher.calls()).toBe(1);
  });

  it('never memoizes a failed artist fetch: the next album with that artist asks again', async () => {
    getArtistDetails
      .mockRejectedValueOnce(new LmlClientError('LML responded with 404', 404))
      .mockResolvedValueOnce({ artist_id: 82730, name: 'Juana Molina' });
    const fetcher = createLmlFetcher(noPacing);

    expect(await fetcher.artist(82730)).toEqual({ ok: false, status: 404 });
    expect(await fetcher.artist(82730)).toMatchObject({ ok: true, memoized: false });
    expect(getArtistDetails).toHaveBeenCalledTimes(2);
  });

  it('paces every LML call, release and artist alike, but not a memo hit', async () => {
    getRelease.mockResolvedValue({ release_id: 7 });
    getArtistDetails.mockResolvedValue({ artist_id: 1, name: 'A' });
    const wait = jest.fn(() => Promise.resolve());
    const fetcher = createLmlFetcher({ wait });

    await fetcher.release(7);
    await fetcher.artist(1);
    await fetcher.artist(1);

    expect(wait).toHaveBeenCalledTimes(2);
  });
});

describe('createLmlFetcher pins', () => {
  it('asks LML for the batch pins under its caller label, unpaced and outside the call count', async () => {
    const results = [{ legacy_release_id: 39541, pin: null }];
    getPinnedTracklists.mockResolvedValue(results);
    const pacer = { wait: jest.fn(() => Promise.resolve()) };
    const fetcher = createLmlFetcher(pacer);

    expect(await fetcher.pins([39541])).toMatchObject({ ok: true, value: results });
    expect(getPinnedTracklists).toHaveBeenCalledWith([39541], { caller: 'album-metadata-extended-fill' });
    // LML answers pins from PostgreSQL alone: no Discogs quota to pace.
    expect(pacer.wait).not.toHaveBeenCalled();
    expect(fetcher.calls()).toBe(0);
  });

  it.each([
    ['a 503 (mapped to 502)', new LmlClientError('LML responded with 502', 502), 502],
    ['a timeout', new LmlClientError('LML request timed out', 504), 504],
  ])('reports %s as a failure with its status', async (_label, error, status) => {
    getPinnedTracklists.mockRejectedValue(error);

    expect(await createLmlFetcher(noPacing).pins([1])).toEqual({ ok: false, status });
  });

  it('rethrows an auth rejection', async () => {
    getPinnedTracklists.mockRejectedValue(new LmlAuthError('rejected', 401));

    await expect(createLmlFetcher(noPacing).pins([1])).rejects.toBeInstanceOf(LmlAuthError);
  });
});

describe('createPacer', () => {
  it('spaces call starts by 60000 / rate ms, and does not wait for the first', async () => {
    let clock = 0;
    const slept: number[] = [];
    const pacer = createPacer(30, {
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });

    await pacer.wait();
    clock += 500;
    await pacer.wait();
    await pacer.wait();

    expect(slept).toEqual([1500, 2000]);
  });
});
