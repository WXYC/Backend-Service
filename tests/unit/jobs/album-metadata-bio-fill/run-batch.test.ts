/**
 * `runBatch` — one bulk LML call, then at most one write per album.
 *
 * `decide.test.ts` covers which verdict a result gets. This file covers what
 * `runBatch` does with a verdict, and the rule is the one the donor drain once
 * got backwards: only `fill` may write. The assertions are on `applyBioFill`
 * NOT being called, because that is the only place the difference shows — the
 * counters alone would pass either way.
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual('@wxyc/lml-client'),
  bulkLookupMetadata: jest.fn(),
}));
jest.mock('../../../../jobs/album-metadata-bio-fill/cohort', () => ({
  applyBioFill: jest.fn(),
}));

import { bulkLookupMetadata as bulkLookupMetadataImport } from '@wxyc/lml-client';
import * as cohort from '../../../../jobs/album-metadata-bio-fill/cohort';
import { computeBulkTimeoutMs, runBatch } from '../../../../jobs/album-metadata-bio-fill/job';
import * as logger from '../../../../jobs/album-metadata-bio-fill/logger';

const bulkLookupMetadata = bulkLookupMetadataImport as unknown as jest.Mock;
const applyBioFill = cohort.applyBioFill as unknown as jest.Mock;

const JUANA = { album_id: 10, legacy_release_id: 1010, artist_name: 'Juana Molina', album_title: 'DOGA' };
const JESSICA = {
  album_id: 11,
  legacy_release_id: 1011,
  artist_name: 'Jessica Pratt',
  album_title: 'On Your Own Love Again',
};
const OPTS = { budgetMs: 25_000 };
const BIO = 'Argentine singer, songwriter and actress.';

const filling = (candidate: typeof JUANA, index: number) => ({
  index,
  status: 'match',
  lookup: {
    search_type: 'direct',
    results: [
      {
        library_item: { id: candidate.legacy_release_id },
        artwork: { release_id: 1, release_url: 'https://www.discogs.com/release/1', artist_bio: BIO },
      },
    ],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  applyBioFill.mockResolvedValue(true as never);
});

describe('runBatch — the request', () => {
  it('asks for extended results on every item and never for the release-resolution fallback', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [filling(JUANA, 0), filling(JESSICA, 1)] } as never);

    await runBatch([JUANA, JESSICA], OPTS);

    const [items, options] = bulkLookupMetadata.mock.calls[0] as [
      Array<Record<string, unknown>>,
      Record<string, unknown>,
    ];
    // `extended` is what switches LML's bio gate from album match to artist
    // identity (LML#504). Without it this job would be asking the wrong gate.
    expect(items).toEqual([
      { artist: 'Juana Molina', album: 'DOGA', raw_message: 'Juana Molina - DOGA', extended: true },
      {
        artist: 'Jessica Pratt',
        album: 'On Your Own Love Again',
        raw_message: 'Jessica Pratt - On Your Own Love Again',
        extended: true,
      },
    ]);
    expect(options).toEqual({
      caller: 'album-metadata-bio-fill',
      budgetMs: 25_000,
      timeoutMs: computeBulkTimeoutMs(2, 25_000),
    });
  });

  // LML clamps any X-Caller-Budget-Ms to its 4 s LML_SEARCH_BUDGET_MS and then
  // sheds an item's artist-details step as deadline_exceeded (BS#2978). `null`
  // is the client's lever for sending no header at all; `undefined` would
  // inherit the caller policy's budget and send one anyway.
  it('sends no budget header when the budget is 0, and waits out LML hard cap', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [filling(JUANA, 0), filling(JESSICA, 1)] } as never);

    await runBatch([JUANA, JESSICA], { budgetMs: 0 });

    expect(bulkLookupMetadata.mock.calls[0][1]).toEqual({
      caller: 'album-metadata-bio-fill',
      budgetMs: null,
      timeoutMs: computeBulkTimeoutMs(2, 0),
    });
  });

  it('makes no call for an empty batch', async () => {
    const result = await runBatch([], OPTS);

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(result.batchSize).toBe(0);
  });
});

describe('runBatch — only a fill writes', () => {
  it('writes the bio for a fill and counts it', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [filling(JUANA, 0)] } as never);

    const result = await runBatch([JUANA], OPTS);

    expect(applyBioFill).toHaveBeenCalledWith(10, { artist_bio: BIO, artist_wikipedia_url: null });
    expect(result).toMatchObject({ fill: 1, filled: 1, skipped_raced: 0, indeterminateAlbumIds: [] });
  });

  it('counts a row that got a bio in the meantime as raced, not filled', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [filling(JUANA, 0)] } as never);
    applyBioFill.mockResolvedValue(false as never);

    const result = await runBatch([JUANA], OPTS);

    expect(result).toMatchObject({ fill: 1, filled: 0, skipped_raced: 1 });
  });

  it('counts a write that throws as write_failed, reports the album for retry, and carries on', async () => {
    const captureError = jest.spyOn(logger, 'captureError');
    const log = jest.spyOn(logger, 'log');
    // The shape drizzle rejects with: its own message is the statement and
    // its parameters, and what the database actually said is on `.cause`.
    const reset = Object.assign(new Error(`Failed query: UPDATE album_metadata SET ... params: ${BIO},,10`), {
      cause: new Error('write CONNECTION_CLOSED'),
    });
    bulkLookupMetadata.mockResolvedValue({ results: [filling(JUANA, 0), filling(JESSICA, 1)] } as never);
    applyBioFill.mockRejectedValueOnce(reset as never);

    const result = await runBatch([JUANA, JESSICA], OPTS);

    // The second album is still written: one row's failure is not the batch's.
    expect(applyBioFill).toHaveBeenCalledTimes(2);
    expect(applyBioFill).toHaveBeenLastCalledWith(11, expect.anything());
    // `write_failed` is its own counter, not `indeterminate`: LML did answer.
    // The album id still goes on the retry list, which is what freezes the
    // resume cursor at it.
    expect(result).toMatchObject({
      fill: 2,
      filled: 1,
      skipped_raced: 0,
      write_failed: 1,
      indeterminate: 0,
      indeterminateAlbumIds: [10],
    });
    expect(captureError).toHaveBeenCalledWith(reset, 'write_failed', { album_id: 10 });
    // The log line is what an operator reads to tell a dead database from a
    // bad row, so it carries the database's reason and not a copy of the bio.
    const [, , , fields] = log.mock.calls.find(([, step]) => step === 'write_failed') ?? [];
    expect(fields).toEqual({ album_id: 10, error_message: 'Error: write CONNECTION_CLOSED' });
  });

  it.each([
    ['no_match', { index: 0, status: 'no_match', lookup: null }, 'no_match'],
    [
      'untrusted',
      { ...filling(JUANA, 0), lookup: { ...filling(JUANA, 0).lookup, search_type: 'alternative' } },
      'untrusted',
    ],
    ['card_mismatch', filling(JESSICA, 0), 'card_mismatch'],
    [
      'no_bio',
      { index: 0, status: 'match', lookup: { search_type: 'direct', results: [{ library_item: { id: 1010 } }] } },
      'no_bio',
    ],
  ] as const)('writes nothing on %s, and does not call it indeterminate', async (_label, item, counter) => {
    bulkLookupMetadata.mockResolvedValue({ results: [item] } as never);

    const result = await runBatch([JUANA], OPTS);

    expect(applyBioFill).not.toHaveBeenCalled();
    expect(result[counter]).toBe(1);
    expect(result.indeterminate).toBe(0);
    expect(result.indeterminateAlbumIds).toEqual([]);
  });

  it.each([['shed_limiter_saturated'], ['shed_breaker_open'], ['error']])(
    'writes nothing on a %s verdict and reports the album as indeterminate',
    async (status) => {
      bulkLookupMetadata.mockResolvedValue({ results: [{ index: 0, status, lookup: { results: [] } }] } as never);

      const result = await runBatch([JUANA], OPTS);

      expect(applyBioFill).not.toHaveBeenCalled();
      expect(result).toMatchObject({ indeterminate: 1, indeterminateAlbumIds: [10], unexpected_index: 0 });
    }
  );

  it('reports a degraded match as indeterminate and logs why, since its status alone says match', async () => {
    const log = jest.spyOn(logger, 'log');
    const shed = {
      index: 0,
      status: 'match',
      lookup: {
        search_type: 'direct',
        degraded: true,
        degraded_reason: 'cache_only',
        results: [{ library_item: { id: 1010 } }],
      },
    };
    bulkLookupMetadata.mockResolvedValue({ results: [shed] } as never);

    const result = await runBatch([JUANA], OPTS);

    expect(applyBioFill).not.toHaveBeenCalled();
    expect(result).toMatchObject({ no_bio: 0, indeterminate: 1, indeterminateAlbumIds: [10] });
    expect(log).toHaveBeenCalledWith(
      'warn',
      'lml_indeterminate',
      expect.any(String),
      expect.objectContaining({ status: 'match', degraded_reason: 'cache_only' })
    );
  });

  it.each([
    ['the bulk call throws', () => bulkLookupMetadata.mockRejectedValue(new Error('ECONNRESET') as never)],
    // A 2xx whose body is not the bulk shape: a proxy's error page parsed as
    // JSON, or a contract break. It is no answer for any album in the batch.
    ['a 2xx body has no results', () => bulkLookupMetadata.mockResolvedValue({} as never)],
    ['a 2xx body has null results', () => bulkLookupMetadata.mockResolvedValue({ results: null } as never)],
    [
      'a 2xx body has results that are not an array',
      () => bulkLookupMetadata.mockResolvedValue({ results: { 0: filling(JUANA, 0) } } as never),
    ],
    ['a 2xx body is null', () => bulkLookupMetadata.mockResolvedValue(null as never)],
  ])('leaves the whole batch indeterminate when %s', async (_label, arrange) => {
    arrange();

    const result = await runBatch([JUANA, JESSICA], OPTS);

    expect(applyBioFill).not.toHaveBeenCalled();
    expect(result).toMatchObject({ indeterminate: 2, indeterminateAlbumIds: [10, 11] });
  });

  it('refuses a result that arrives out of input order, and still settles its neighbour (BS#1088 pin)', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [filling(JUANA, 0), filling(JESSICA, 7)] } as never);

    const result = await runBatch([JUANA, JESSICA], OPTS);

    expect(applyBioFill).toHaveBeenCalledTimes(1);
    expect(applyBioFill).toHaveBeenCalledWith(10, expect.anything());
    expect(result).toMatchObject({ filled: 1, indeterminate: 1, unexpected_index: 1, indeterminateAlbumIds: [11] });
  });
});

describe('computeBulkTimeoutMs', () => {
  it.each([
    // With a budget header LML stops each item at its budget.
    [5, 4_000, 30_000],
    [1, 4_000, 10_000],
    // With none an item can run to LML's 25 s hard cap, so one slow album
    // must not time out the whole batch.
    [5, 0, 55_000],
    [1, 0, 35_000],
  ])('batch of %i with budget %i waits %i ms', (batchSize, budgetMs, expected) => {
    expect(computeBulkTimeoutMs(batchSize, budgetMs)).toBe(expected);
  });
});
