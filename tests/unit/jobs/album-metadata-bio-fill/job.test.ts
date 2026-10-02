/**
 * Options and the dry run for the BS#2775 bio fill.
 *
 * The dry run is the default and is what an operator runs first to size the
 * job, so the property that matters is that it reads and reports and does
 * nothing else: no LML call, no write.
 *
 * `cohort` is mocked here because its SQL has its own spec; this file is about
 * what `runFill` does with what the cohort returns.
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual('@wxyc/lml-client'),
  bulkLookupMetadata: jest.fn(),
}));
// The real module's constants, READ_TIMEOUT_DEFAULT among them, with its reads
// stubbed. A bare factory left the timeout default undefined, so assertions on
// it compared undefined with undefined.
jest.mock('../../../../jobs/album-metadata-bio-fill/cohort', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../../jobs/album-metadata-bio-fill/cohort'),
  countCohort: jest.fn(),
  countEligible: jest.fn(),
  enumerateCohort: jest.fn(),
}));

import { db } from '@wxyc/database';
import { BULK_LOOKUP_INPUT_CAP, bulkLookupMetadata as bulkLookupMetadataImport } from '@wxyc/lml-client';
import * as cohort from '../../../../jobs/album-metadata-bio-fill/cohort';
import { resolveOptions, runFill } from '../../../../jobs/album-metadata-bio-fill/job';

const bulkLookupMetadata = bulkLookupMetadataImport as unknown as jest.Mock;
const countCohort = cohort.countCohort as unknown as jest.Mock;
const countEligible = cohort.countEligible as unknown as jest.Mock;
const enumerateCohort = cohort.enumerateCohort as unknown as jest.Mock;

const candidates = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    album_id: i + 1,
    legacy_release_id: 1000 + i,
    artist_name: 'Juana Molina',
    album_title: 'DOGA',
  }));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveOptions', () => {
  it('defaults to a dry run with the conservative donor pacing and no cap or cursor', () => {
    expect(resolveOptions({}, ['node', 'job.js'])).toMatchObject({
      execute: false,
      batchSize: 5,
      ratePerMin: 1,
      budgetMs: 25_000,
      readTimeoutMs: 300_000,
      maxAlbums: 0,
      afterAlbumId: 0,
      maxConsecutiveFailedBatches: 3,
      maxConsecutiveNoBioBatches: 10,
    });
  });

  it('writes only on the explicit --execute flag', () => {
    expect(resolveOptions({}, ['node', 'job.js', '--execute']).execute).toBe(true);
    // `album-level-backfill` writes by default and takes `--dry-run` to opt
    // out. Someone carrying that muscle memory here must still get a dry run.
    expect(resolveOptions({}, ['node', 'job.js', '--dry-run']).execute).toBe(false);
  });

  it('reads every knob from its BIO_FILL_ env var', () => {
    const options = resolveOptions(
      {
        BIO_FILL_BULK_BATCH_SIZE: '10',
        BIO_FILL_BULK_RATE_PER_MIN: '4',
        BIO_FILL_BULK_BUDGET_MS: '20000',
        BIO_FILL_MAX_ALBUMS: '2400',
        BIO_FILL_ALBUM_AFTER_ID: '53799',
        BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES: '5',
        BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES: '25',
      },
      []
    );

    expect(options).toMatchObject({
      batchSize: 10,
      ratePerMin: 4,
      budgetMs: 20_000,
      maxAlbums: 2400,
      afterAlbumId: 53799,
      maxConsecutiveFailedBatches: 5,
      maxConsecutiveNoBioBatches: 25,
    });
  });

  it.each([
    ['BIO_FILL_BULK_BATCH_SIZE', '0'],
    ['BIO_FILL_BULK_BATCH_SIZE', 'five'],
    ['BIO_FILL_BULK_BATCH_SIZE', '101'],
    ['BIO_FILL_BULK_RATE_PER_MIN', '-1'],
    ['BIO_FILL_MAX_ALBUMS', '-25'],
    ['BIO_FILL_ALBUM_AFTER_ID', '1.5'],
    ['BIO_FILL_MAX_CONSECUTIVE_FAILED_BATCHES', '0'],
    ['BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES', '-1'],
    ['BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES', 'ten'],
  ])('rejects %s=%s instead of falling back to a default', (name, value) => {
    expect(() => resolveOptions({ [name]: value }, [])).toThrow(name);
  });

  it('takes 0 for the no-bio guard as "disabled", the one failure guard an operator may need to turn off', () => {
    expect(resolveOptions({ BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES: '0' }, []).maxConsecutiveNoBioBatches).toBe(0);
  });

  it('bounds the batch size at the LML client cap, and says what the cap is', () => {
    // `bulkLookupMetadata` throws client-side above the cap. A dry run never
    // calls it, so an oversize batch would plan cleanly and then abort the
    // execute run as consecutive failed batches.
    expect(resolveOptions({ BIO_FILL_BULK_BATCH_SIZE: String(BULK_LOOKUP_INPUT_CAP) }, []).batchSize).toBe(100);
    expect(() => resolveOptions({ BIO_FILL_BULK_BATCH_SIZE: '500' }, [])).toThrow(/at most 100/);
  });
});

describe('runFill — dry run', () => {
  beforeEach(() => {
    countCohort.mockResolvedValue(12_940 as never);
    countEligible.mockResolvedValue(12_900 as never);
    enumerateCohort.mockResolvedValue(candidates(12) as never);
  });

  it('reports the cohort, the permanently excluded rows, and the batch plan', async () => {
    const summary = await runFill(resolveOptions({}, []));

    expect(summary).toMatchObject({
      execute: false,
      cohortBefore: 12_940,
      eligible: 12_900,
      excluded: 40,
      enumerated: 12,
      batches: 3,
    });
  });

  it('makes no LML call and issues no statement of its own', async () => {
    await runFill(resolveOptions({}, []));

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('enumerates from the cursor and under the cap', async () => {
    const options = resolveOptions({ BIO_FILL_MAX_ALBUMS: '25', BIO_FILL_ALBUM_AFTER_ID: '53799' }, []);

    await runFill(options);

    expect(enumerateCohort).toHaveBeenCalledWith(25, 53799, options.readTimeoutMs);
  });
});
