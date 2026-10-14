/**
 * `runBatch` — one bulk LML call, then at most one guarded write per admitted album (BS#3145).
 *
 * `decide.test.ts` covers which verdict a result gets. This file covers what `runBatch` does with it: only `rebind`,
 * `rebind_unpinned` and `clear` reach `db.execute`, so the assertions are on `db.execute` NOT being called, the one
 * place a verdict that wrongly writes would show. It also covers the join of the three row types built in parallel:
 * the cohort row, the manifest entry it was admitted on, and decide's `ReaskCandidate`.
 *
 * @see WXYC/Backend-Service#3145
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual('@wxyc/lml-client'),
  bulkLookupMetadata: jest.fn(),
}));

import { db } from '@wxyc/database';
import { bulkLookupMetadata as bulkLookupMetadataImport } from '@wxyc/lml-client';
import type { ReaskCandidate as CohortRow } from '../../../../jobs/album-metadata-reask/cohort';
import type { ManifestEntry } from '../../../../jobs/album-metadata-reask/inputs';
import * as logger from '../../../../jobs/album-metadata-reask/logger';
import { runBatch, toCandidate, type AdmittedRow } from '../../../../jobs/album-metadata-reask/run-batch';

const bulkLookupMetadata = bulkLookupMetadataImport as unknown as jest.Mock;
const execute = db.execute as unknown as jest.Mock;

const PIN = 4101;
const STORED = 4102;
const EXPECTED = 4103;
const OPTS = { runId: 'run-1', pinExportSha256: 'abc123', timeoutMs: 60_000 };

const cohortRow = (over: Partial<CohortRow>): CohortRow => ({
  album_id: 10,
  legacy_release_id: 1001,
  discogs_url: `https://www.discogs.com/release/${STORED}`,
  artwork_url: null,
  library_artwork_url: null,
  stored_release_id: STORED,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  reason: 'pin_mismatch',
  pin_release_id: PIN,
  pin_source: 'alex-l-2026-masters-api',
  ...over,
});

const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
  library_id: 1001,
  stored_release_id: STORED,
  pin_release_id: PIN,
  pin_source: 'alex-l-2026-masters-api',
  stored_title_score: null,
  pin_title_score: null,
  stored_play_rate: null,
  pin_play_rate: null,
  excluded_other_plays: 0,
  excluded_inferred_plays: 0,
  tier: 'rebind',
  expected_release_id: null,
  ...over,
});

const MISMATCH: AdmittedRow = { row: cohortRow({}), entry: entry({}) };
const removed = (expected: number | null): AdmittedRow => ({
  row: cohortRow({
    album_id: 11,
    legacy_release_id: 1002,
    artist_name: 'Stereolab',
    album_title: 'Dots and Loops',
    reason: 'pin_removed',
    pin_release_id: null,
  }),
  entry: entry({ library_id: 1002, pin_release_id: STORED, expected_release_id: expected }),
});

/** A direct match on `admitted`'s card for `releaseId`, with lookup and artwork overrides. */
const answer = (
  admitted: AdmittedRow,
  releaseId: number,
  { lookup = {}, artwork = {} }: { lookup?: object; artwork?: object } = {},
  index = 0
) => ({
  index,
  status: 'match',
  lookup: {
    search_type: 'direct',
    results: [
      {
        library_item: { id: admitted.row.legacy_release_id },
        artwork: {
          release_id: releaseId,
          release_url: `https://www.discogs.com/release/${releaseId}`,
          artwork_url: `https://i.discogs.com/${releaseId}.jpg`,
          ...artwork,
        },
      },
    ],
    ...lookup,
  },
});
const noMatch = (index = 0) => ({ index, status: 'no_match', lookup: null });

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue([{ album_id: 10, artist_cleared: false }]);
});

describe('toCandidate — the join of cohort row, manifest entry and decide candidate', () => {
  it.each([
    ['a pin mismatch takes the pin it was admitted on', MISMATCH, { reason: 'pin_mismatch', pin_release_id: PIN }],
    [
      'a removed pin takes the removed release and the expected one from the manifest',
      removed(EXPECTED),
      { reason: 'pin_removed', stored_release_id: STORED, expected_release_id: EXPECTED },
    ],
  ])('%s', (_label, admitted, expected) => {
    expect(toCandidate(admitted)).toEqual({
      legacy_release_id: admitted.row.legacy_release_id,
      artist_name: admitted.row.artist_name,
      album_title: admitted.row.album_title,
      ...expected,
    });
  });
});

describe('runBatch — the request', () => {
  it('asks with the release-resolution fallback on and no budget header', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [answer(MISMATCH, PIN)] } as never);

    await runBatch([MISMATCH], OPTS);

    expect(bulkLookupMetadata).toHaveBeenCalledWith(
      [{ artist: 'Juana Molina', album: 'DOGA', raw_message: 'Juana Molina - DOGA', extended: true }],
      { caller: 'album-metadata-reask', allowReleaseResolutionFallback: true, budgetMs: null, timeoutMs: 60_000 }
    );
  });

  it('makes no call for an empty batch', async () => {
    await runBatch([], OPTS);

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });
});

describe('runBatch — only a writing verdict writes', () => {
  it.each([
    [
      'indeterminate (degraded)',
      MISMATCH,
      answer(MISMATCH, PIN, { lookup: { degraded: true, degraded_reason: 'cache_only' } }),
    ],
    ['no_match', MISMATCH, noMatch()],
    ['untrusted', MISMATCH, answer(MISMATCH, PIN, { lookup: { search_type: 'fuzzy' } })],
    ['card_mismatch', MISMATCH, answer({ ...MISMATCH, row: cohortRow({ legacy_release_id: 9 }) }, PIN)],
    ['pin_not_bound', MISMATCH, answer(MISMATCH, STORED)],
    ['matcher_agrees_with_removed', removed(EXPECTED), answer(removed(EXPECTED), STORED)],
    ['unpinned_drifted', removed(EXPECTED), noMatch()],
    ['incomplete', MISMATCH, answer(MISMATCH, PIN, { artwork: { release_url: null } })],
  ])('%s does not touch the database', async (kind, admitted, item) => {
    const log = jest.spyOn(logger, 'log');
    bulkLookupMetadata.mockResolvedValue({ results: [item] } as never);

    const { totals } = await runBatch([admitted], OPTS);

    expect(execute).not.toHaveBeenCalled();
    expect(totals).toEqual({ [kind.split(' ')[0]]: 1 });
    // Each names its album, so a listed verdict can be traced without a re-run.
    expect(log).toHaveBeenCalledWith(
      'info',
      'not_written',
      expect.any(String),
      expect.objectContaining({ album_id: admitted.row.album_id, verdict: kind.split(' ')[0] })
    );
  });

  it.each([
    ['a thrown call', () => bulkLookupMetadata.mockRejectedValue(new Error('timeout') as never)],
    ['a 2xx with no results array', () => bulkLookupMetadata.mockResolvedValue({} as never)],
  ])('%s leaves the whole batch indeterminate, carried, and unwritten', async (_label, arrange) => {
    arrange();

    const result = await runBatch([MISMATCH, removed(null)], OPTS);

    expect(execute).not.toHaveBeenCalled();
    expect(result.totals.indeterminate).toBe(2);
    expect(result.carriedAlbumIds).toEqual([10, 11]);
  });

  it('counts and reports a result out of input order, an LML contract break', async () => {
    const captureError = jest.spyOn(logger, 'captureError');
    bulkLookupMetadata.mockResolvedValue({ results: [answer(MISMATCH, PIN, {}, 1)] } as never);

    const result = await runBatch([MISMATCH], OPTS);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({ totals: { indeterminate: 1, unexpected_index: 1 }, carriedAlbumIds: [10] });
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), 'unexpected_index', { album_id: 10 });
  });

  it.each([
    ['rebind', MISMATCH, answer(MISMATCH, PIN)],
    ['rebind_unpinned', removed(EXPECTED), answer(removed(EXPECTED), EXPECTED)],
    ['clear', removed(null), noMatch()],
  ])('%s writes once, with its provenance', async (kind, admitted, item) => {
    bulkLookupMetadata.mockResolvedValue({ results: [item] } as never);

    const { totals } = await runBatch([admitted], OPTS);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(totals).toEqual({ [kind]: 1, written: 1 });
    const values = JSON.stringify(execute.mock.calls[0]);
    expect(values).toContain('abc123');
    expect(values).toContain(`\\"verdict\\":\\"${kind}\\"`);
  });

  it('counts a failed guard as skipped_raced, a cleared bio as artist_cleared, and a throw as write_failed', async () => {
    const second = {
      ...MISMATCH,
      row: cohortRow({ album_id: 12, legacy_release_id: 1003 }),
      entry: entry({ library_id: 1003 }),
    };
    const third = {
      ...MISMATCH,
      row: cohortRow({ album_id: 13, legacy_release_id: 1004 }),
      entry: entry({ library_id: 1004 }),
    };
    bulkLookupMetadata.mockResolvedValue({
      results: [answer(MISMATCH, PIN), answer(second, PIN, {}, 1), answer(third, PIN, {}, 2)],
    } as never);
    execute
      .mockResolvedValueOnce([{ album_id: 10, artist_cleared: true }] as never)
      .mockResolvedValueOnce([] as never)
      .mockRejectedValueOnce(new Error('lock timeout') as never);

    const result = await runBatch([MISMATCH, second, third], OPTS);

    expect(result.totals).toMatchObject({
      rebind: 3,
      written: 1,
      artist_cleared: 1,
      skipped_raced: 1,
      write_failed: 1,
    });
    expect(result.carriedAlbumIds).toEqual([13]);
  });
});
