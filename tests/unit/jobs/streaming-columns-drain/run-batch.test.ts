/**
 * `runBatch` verdict routing for the BS#2295 drain.
 *
 * The rule under test is the one an earlier draft of this job got backwards,
 * and it is the difference between a retryable row and a permanently broken
 * one: **only a definitive verdict may be written.** A shed, a per-item
 * error, an out-of-order result, or a thrown bulk call must write NOTHING, so
 * the row stays in the cohort and the next run retries it.
 *
 * Why that matters concretely: writing a synthesized-only fill on a shed
 * would take the row out of the cohort permanently, satisfy `precheck.ts`'s
 * `hasAnyStreamingUrl` conjunct so the next play skips LML again, and leave
 * `streaming-reask.ts` unable to see it (all statuses NULL). One LML restart
 * mid-drain would have nulled Spotify and Apple on every remaining album, and
 * nothing anywhere would ever have re-asked.
 *
 * These assert on `db.execute` NOT being called, which is the only place the
 * difference is observable — the counters alone would pass either way.
 *
 * @see WXYC/Backend-Service#2295
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@wxyc/lml-client', () => ({ bulkLookupMetadata: jest.fn() }));

import { db } from '@wxyc/database';
import { bulkLookupMetadata as bulkLookupMetadataImport } from '@wxyc/lml-client';
import { runBatch } from '../../../../jobs/streaming-columns-drain/job';

const bulkLookupMetadata = bulkLookupMetadataImport as unknown as jest.Mock;

const CANDIDATE = { album_id: 42, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' };
const OPTS = { budgetMs: 25_000 };

/** One bulk result item at position 0 with the given status. */
const itemAt0 = (status: string, extra: Record<string, unknown> = {}) => ({
  results: [{ index: 0, status, lookup: { results: [] }, ...extra }],
});

describe('runBatch — only definitive verdicts are written', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: 42 }] as never);
  });

  it.each([['shed_limiter_saturated'], ['shed_breaker_open'], ['error']])(
    'writes nothing and counts indeterminate on a %s verdict',
    async (status) => {
      bulkLookupMetadata.mockResolvedValue(itemAt0(status) as never);

      const result = await runBatch([CANDIDATE], OPTS);

      expect(result.indeterminate).toBe(1);
      expect(result.filled).toBe(0);
      expect(db.execute).not.toHaveBeenCalled();
    }
  );

  it('writes nothing when the whole bulk call throws — the batch is retried next run', async () => {
    bulkLookupMetadata.mockRejectedValue(new Error('ECONNRESET') as never);

    const result = await runBatch([CANDIDATE, { ...CANDIDATE, album_id: 43 }], OPTS);

    expect(result.indeterminate).toBe(2);
    expect(result.filled).toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('writes nothing when LML returns a result out of input order (BS#1088 pin)', async () => {
    // A silently-reordered bulk response would otherwise write one album's
    // streaming URLs onto another.
    bulkLookupMetadata.mockResolvedValue({
      results: [{ index: 7, status: 'match', lookup: { results: [{ artwork: { artwork_url: 'x' } }] } }],
    } as never);

    const result = await runBatch([CANDIDATE], OPTS);

    expect(result.unexpected_index).toBe(1);
    expect(result.indeterminate).toBe(1);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('does NOT read a shed as a match just because `lookup` is non-null', async () => {
    // The trap `buildShedBulkResultItem`'s docstring warns about: a shed
    // carries a placeholder `lookup`, so branching on nullity instead of
    // status would treat it as a successful match.
    bulkLookupMetadata.mockResolvedValue(itemAt0('shed_breaker_open') as never);

    const result = await runBatch([CANDIDATE], OPTS);

    expect(result.match).toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('writes on a no_match — the synthesized fill is what takes the row out of the cohort', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [{ index: 0, status: 'no_match', lookup: null }] } as never);

    const result = await runBatch([CANDIDATE], OPTS);

    expect(result.no_match).toBe(1);
    expect(result.filled).toBe(1);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('writes on a match', async () => {
    bulkLookupMetadata.mockResolvedValue({
      results: [
        {
          index: 0,
          status: 'match',
          lookup: {
            results: [{ artwork: { artwork_url: 'https://i.discogs.com/x.jpg', release_url: 'https://d/1' } }],
          },
        },
      ],
    } as never);

    const result = await runBatch([CANDIDATE], OPTS);

    expect(result.match).toBe(1);
    expect(result.filled).toBe(1);
  });

  it('counts a raced row as skipped rather than filled when the UPDATE matches nothing', async () => {
    bulkLookupMetadata.mockResolvedValue({ results: [{ index: 0, status: 'no_match', lookup: null }] } as never);
    (db.execute as jest.Mock).mockResolvedValue([] as never);

    const result = await runBatch([CANDIDATE], OPTS);

    expect(result.filled).toBe(0);
    expect(result.skipped_raced).toBe(1);
  });
});
